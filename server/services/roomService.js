const logger = require("../../utils/logger");
const {
  sanitizePlayerName,
  sanitizeSessionId,
  sanitizeMaxPlayers,
  sanitizeRoundDurationMs,
} = require("../schemas/validation");

// Сколько ждать переподключения игрока, если он отвалился во время
// активного раунда (подготовка/музыка/голосование), прежде чем убрать
// его насовсем. В лобби ("waiting" и не идёт голосование) ждать нет
// смысла — там потеря состояния ничем не грозит, убираем сразу.
const DISCONNECT_GRACE_MS = 20000;

// Вся работа с комнатами и игроками живёт здесь, в памяти процесса (Map),
// без единого socket.io emit — сервис только меняет состояние и
// возвращает структурированный результат, а что и кому отправить,
// решает вызывающий код (socketController).
//
// `io` нужен сервису для двух вещей: (1) если "призрачный" сокет
// человека, который уже открыл комнату под новым соединением, ещё
// технически жив, мы выводим его из комнаты socket.io; (2) не более —
// самих событий сервис не шлёт.
function createRoomService(io, { roomIdLength }) {
  const rooms = new Map(); // roomId -> room
  const socketToRoom = new Map(); // socket.id -> roomId

  function generateRoomId() {
    return Math.random()
      .toString(36)
      .substring(2, 2 + roomIdLength)
      .toUpperCase();
  }

  function generatePassword() {
    const chars = "ABCDEFGHIJKLMNPQRSTUVWXYZ123456789";
    let password = "";
    for (let i = 0; i < 4; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }

  function createPlayer(socketId, sessionId, name) {
    return {
      id: socketId,
      sessionId,
      name,
      isReady: false,
      role: "crewmate",
      hasVoted: false,
      votedFor: null,
      connected: true,
      disconnectTimer: null,
    };
  }

  function clearDisconnectTimer(player) {
    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
  }

  // Игрок в виде, безопасном для отправки клиентам: sessionId и
  // disconnectTimer — внутренние технические детали, их не должны
  // видеть другие игроки.
  function toPublicPlayer(player, room) {
    if (!player) return null;
    return {
      id: player.id,
      name: player.name,
      isReady: player.isReady,
      role: player.role,
      hasVoted: player.hasVoted,
      votedFor: player.votedFor,
      connected: player.connected !== false,
      isHost: !!(
        room &&
        player.sessionId &&
        room.hostSessionId === player.sessionId
      ),
    };
  }

  function getPublicPlayers(room) {
    return Array.from(room.players.values()).map((p) =>
      toPublicPlayer(p, room)
    );
  }

  function getVotedPlayersSummary(room) {
    return Array.from(room.players.values())
      .filter((p) => p.hasVoted)
      .map((p) => ({ id: p.id, name: p.name }));
  }

  // Стандартный payload события "room-info".
  function getRoomInfo(room) {
    return {
      password: room.password,
      players: getPublicPlayers(room),
      readyCount: room.readyCount,
      voting: room.voting,
      votes: room.votes,
      maxPlayers: room.maxPlayers,
      roundDuration: room.roundDuration,
    };
  }

  // Раунд считается "активным", если прерывать его потерей игрока
  // нежелательно: идёт подготовка/музыка или голосование. Обратите
  // внимание, что во время голосования room.status всё ещё "waiting"
  // (так было устроено изначально) — поэтому проверяем ещё и room.voting.
  function isRoundActive(room) {
    return (
      room.status === "preparing" || room.status === "playing" || room.voting
    );
  }

  // --- Дедупликация / переподключение игроков ---
  //
  // Клиент использует ДВА разных socket.io-соединения: одно на главной
  // странице (создание/подключение к комнате) и новое — на странице
  // комнаты (identify-room). Кроме того, во время игры у человека может
  // просто моргнуть связь, и socket.io переподключится под новым
  // socket.id. В обоих случаях клиент присылает один и тот же постоянный
  // на вкладку "sessionId" (хранится в sessionStorage).
  //
  // Раньше в этой ситуации старая запись просто удалялась, а взамен
  // создавалась новая — это решало проблему дублей в лобби, но во время
  // игры стирало роль игрока, его голос и статус готовности. Теперь мы
  // "переносим" существующего игрока на новый socket.id, сохраняя всё
  // его состояние, и поправляем ссылки на старый id (кто предатель, кто
  // за кого проголосовал), которые иначе указывали бы в никуда.
  function reclaimStalePlayer(room, sessionId, newSocketId, playerName) {
    if (!sessionId) return null;

    for (const [oldSocketId, existingPlayer] of room.players.entries()) {
      if (oldSocketId === newSocketId) continue;
      if (existingPlayer.sessionId !== sessionId) continue;

      logger.debug(
        `♻️ Reclaiming session for ${existingPlayer.name}: ${oldSocketId} -> ${newSocketId}`
      );

      clearDisconnectTimer(existingPlayer);

      // Переносим ссылки на старый socket.id (роль предателя, чужие
      // голоса "за" этого игрока), иначе они будут указывать в никуда.
      if (room.impostor === oldSocketId) {
        room.impostor = newSocketId;
      }
      if (
        room.votes &&
        Object.prototype.hasOwnProperty.call(room.votes, oldSocketId)
      ) {
        room.votes[newSocketId] =
          (room.votes[newSocketId] || 0) + room.votes[oldSocketId];
        delete room.votes[oldSocketId];
      }
      room.players.forEach((p) => {
        if (p.votedFor === oldSocketId) {
          p.votedFor = newSocketId;
        }
      });

      room.players.delete(oldSocketId);
      socketToRoom.delete(oldSocketId);

      // Если старый сокет ещё технически жив (не успел разорваться),
      // выводим его из комнаты socket.io, чтобы он не получал её события.
      const staleSocket = io.sockets.sockets.get(oldSocketId);
      if (staleSocket) {
        staleSocket.leave(room.id);
      }

      existingPlayer.id = newSocketId;
      existingPlayer.connected = true;
      if (playerName) {
        existingPlayer.name = playerName;
      }

      room.players.set(newSocketId, existingPlayer);
      return existingPlayer;
    }

    return null;
  }

  function createRoom(
    socketId,
    rawPlayerName,
    rawSessionId,
    rawMaxPlayers,
    rawRoundDurationSeconds
  ) {
    const playerName = sanitizePlayerName(rawPlayerName);
    const sessionId = sanitizeSessionId(rawSessionId);
    const maxPlayers = sanitizeMaxPlayers(rawMaxPlayers);
    const roundDuration = sanitizeRoundDurationMs(rawRoundDurationSeconds);

    const roomId = generateRoomId();
    const password = generatePassword();
    const room = {
      id: roomId,
      password,
      players: new Map(),
      readyCount: 0,
      status: "waiting",
      impostor: null,
      currentSounds: null,
      voting: false,
      votes: {},
      createdAt: Date.now(),
      maxPlayers,
      roundDuration,
      // Хост — создатель комнаты, определяется по sessionId (а не
      // socket.id, который меняется при переходе на страницу комнаты).
      hostSessionId: sessionId,
    };

    const player = createPlayer(socketId, sessionId, playerName || "Player1");
    room.players.set(socketId, player);
    rooms.set(roomId, room);
    socketToRoom.set(socketId, roomId);

    return { room, player };
  }

  function findRoomByPassword(password) {
    for (const [roomId, room] of rooms.entries()) {
      if (room.password === password) {
        return { roomId, room };
      }
    }
    return { roomId: null, room: null };
  }

  function joinRoom(socketId, roomPassword, rawPlayerName, rawSessionId) {
    const playerName = sanitizePlayerName(rawPlayerName);
    const sessionId = sanitizeSessionId(rawSessionId);

    const { roomId, room } = findRoomByPassword(roomPassword);
    if (!room) {
      return { error: "not_found" };
    }
    if (room.players.size >= room.maxPlayers) {
      return { error: "full" };
    }
    if (room.status !== "waiting") {
      return { error: "started" };
    }

    let player = reclaimStalePlayer(room, sessionId, socketId, playerName);
    if (!player) {
      player = createPlayer(
        socketId,
        sessionId,
        playerName || `Player${room.players.size + 1}`
      );
      room.players.set(socketId, player);
    }
    socketToRoom.set(socketId, roomId);

    return { roomId, room, player };
  }

  function identify(socketId, roomId, rawPlayerName, rawSessionId) {
    const playerName = sanitizePlayerName(rawPlayerName);
    const sessionId = sanitizeSessionId(rawSessionId);

    const room = rooms.get(roomId);
    if (!room) return { error: "not_found" };

    let player = room.players.get(socketId);

    if (!player) {
      player = reclaimStalePlayer(room, sessionId, socketId, playerName);
      if (!player) {
        player = createPlayer(
          socketId,
          sessionId,
          playerName || `Player${room.players.size + 1}`
        );
        room.players.set(socketId, player);
      }
    } else {
      if (playerName && player.name !== playerName) {
        player.name = playerName;
      }
      if (sessionId && !player.sessionId) {
        player.sessionId = sessionId;
      }
    }

    socketToRoom.set(socketId, roomId);

    return { room, player };
  }

  function getRoom(roomId) {
    return rooms.get(roomId) || null;
  }

  function setPlayerReady(socketId, roomId, ready) {
    const room = rooms.get(roomId);
    if (!room) return { error: "not_found" };

    const player = room.players.get(socketId);
    if (!player) return { error: "player_not_found" };

    if (room.status !== "waiting") return { error: "started" };

    if (ready && !player.isReady) {
      player.isReady = true;
      room.readyCount++;
      return { room, player, changed: true };
    }
    if (!ready && player.isReady) {
      player.isReady = false;
      room.readyCount--;
      return { room, player, changed: true };
    }
    return { room, player, changed: false };
  }

  function recordVote(roomId, voterSocketId, votedPlayerId) {
    const room = rooms.get(roomId);
    if (!room || !room.voting) return { error: "not_voting" };

    const voter = room.players.get(voterSocketId);
    const votedPlayer = room.players.get(votedPlayerId);
    if (!voter || !votedPlayer) return { error: "not_found" };

    // Если игрок уже голосовал, убираем его предыдущий голос
    if (voter.hasVoted && voter.votedFor) {
      if (room.votes[voter.votedFor]) {
        room.votes[voter.votedFor]--;
        if (room.votes[voter.votedFor] <= 0) {
          delete room.votes[voter.votedFor];
        }
      }
    }

    voter.hasVoted = true;
    voter.votedFor = votedPlayerId;
    room.votes[votedPlayerId] = (room.votes[votedPlayerId] || 0) + 1;

    const votedPlayers = getVotedPlayersSummary(room);
    const allVoted = Array.from(room.players.values()).every(
      (p) => p.hasVoted
    );

    return { room, voter, votedPlayer, votedPlayers, allVoted };
  }

  function cancelVote(roomId, voterSocketId) {
    const room = rooms.get(roomId);
    if (!room || !room.voting) return { error: "not_voting" };

    const voter = room.players.get(voterSocketId);
    if (!voter || !voter.hasVoted) return { error: "not_voted" };

    if (voter.votedFor && room.votes[voter.votedFor]) {
      room.votes[voter.votedFor]--;
      if (room.votes[voter.votedFor] <= 0) {
        delete room.votes[voter.votedFor];
      }
    }
    voter.hasVoted = false;
    voter.votedFor = null;

    return { room, votedPlayers: getVotedPlayersSummary(room) };
  }

  // Обрабатывает disconnect сокета. В лобби убираем игрока сразу (как и
  // раньше) — там терять нечего. Во время активного раунда/голосования
  // даём DISCONNECT_GRACE_MS на переподключение (обрыв связи, обновление
  // страницы): игрок помечается connected:false, но остаётся в комнате
  // со своей ролью/голосом/готовностью. Если он не вернётся вовремя —
  // удаляем насовсем и зовём onGraceExpired, чтобы вызывающий код
  // (socketController) разослал обновлённое состояние и проверил,
  // например, не завершилось ли теперь голосование.
  function handleDisconnect(socketId, onGraceExpired) {
    const roomId = socketToRoom.get(socketId);
    socketToRoom.delete(socketId);
    if (!roomId) return null;

    const room = rooms.get(roomId);
    if (!room) return null;

    const player = room.players.get(socketId);
    if (!player) return null;

    if (!isRoundActive(room)) {
      if (player.isReady && room.readyCount > 0) {
        room.readyCount--;
      }
      room.players.delete(socketId);
      return { roomId, room, player, permanentlyRemoved: true };
    }

    logger.debug(
      `⏳ ${player.name} disconnected during an active round — waiting ${DISCONNECT_GRACE_MS}ms for reconnect`
    );
    player.connected = false;
    player.disconnectTimer = setTimeout(() => {
      const stillSamePlayer = room.players.get(socketId) === player;
      if (stillSamePlayer && !player.connected) {
        logger.debug(`🚪 ${player.name} did not reconnect in time — removing`);
        if (player.isReady && room.readyCount > 0) {
          room.readyCount--;
        }
        room.players.delete(socketId);
        if (typeof onGraceExpired === "function") {
          onGraceExpired({ roomId, room, player });
        }
      }
    }, DISCONNECT_GRACE_MS);

    return { roomId, room, player, permanentlyRemoved: false };
  }

  function deleteRoomIfEmpty(roomId) {
    const room = rooms.get(roomId);
    if (room && room.players.size === 0) {
      rooms.delete(roomId);
      return true;
    }
    return false;
  }

  return {
    getPublicPlayers,
    toPublicPlayer,
    getVotedPlayersSummary,
    getRoomInfo,
    createRoom,
    joinRoom,
    identify,
    getRoom,
    setPlayerReady,
    recordVote,
    cancelVote,
    handleDisconnect,
    deleteRoomIfEmpty,
  };
}

module.exports = { createRoomService };
