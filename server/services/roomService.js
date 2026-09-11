const {
  sanitizePlayerName,
  sanitizeSessionId,
} = require("../schemas/validation");

// Вся работа с комнатами и игроками живёт здесь, в памяти процесса (Map),
// без единого socket.io emit — сервис только меняет состояние и
// возвращает структурированный результат, а что и кому отправить,
// решает вызывающий код (socketController).
//
// `io` нужен сервису только для одной вещи: если "призрачный" сокет
// человека, который уже открыл комнату под новым соединением, ещё
// технически жив, мы выводим его из комнаты socket.io (см.
// removeStaleSessionPlayers) — но самих событий сервис не шлёт.
function createRoomService(io, { maxPlayers, roomIdLength }) {
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
    };
  }

  // Один игрок в виде, безопасном для отправки клиентам: sessionId —
  // внутренний технический идентификатор, его не должны видеть другие игроки.
  function toPublicPlayer(player) {
    if (!player) return null;
    return {
      id: player.id,
      name: player.name,
      isReady: player.isReady,
      role: player.role,
      hasVoted: player.hasVoted,
      votedFor: player.votedFor,
    };
  }

  function getPublicPlayers(room) {
    return Array.from(room.players.values()).map(toPublicPlayer);
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
      maxPlayers,
    };
  }

  // --- Дедупликация игроков при переходе index.html -> room.html ---
  //
  // Клиент использует ДВА разных socket.io-соединения: одно на главной
  // странице (создание/подключение к комнате) и новое — на странице
  // комнаты (identify-room). Когда браузер переходит по ссылке, старое
  // соединение закрывается не мгновенно (иногда сервер узнаёт о разрыве
  // только через несколько секунд), а новое уже успевает представиться
  // в той же комнате. Из-за этого один и тот же человек на короткое
  // (а иногда и не очень) время виден как два игрока с одинаковым именем.
  //
  // Клиент передаёт "sessionId" — один раз сгенерированный идентификатор
  // вкладки (хранится в sessionStorage) — во всех запросах
  // create-room/join-room/identify-room. Перед тем как добавить игрока
  // под новым socket.id, мы удаляем из комнаты любую "устаревшую" запись
  // с тем же sessionId.
  function removeStaleSessionPlayers(room, sessionId, excludeSocketId) {
    if (!room || !sessionId) return;

    for (const [existingSocketId, existingPlayer] of room.players.entries()) {
      if (
        existingSocketId !== excludeSocketId &&
        existingPlayer.sessionId === sessionId
      ) {
        console.log(
          `♻️ Removing stale duplicate of ${existingPlayer.name} (old socket ${existingSocketId})`
        );

        if (existingPlayer.isReady && room.readyCount > 0) {
          room.readyCount--;
        }

        room.players.delete(existingSocketId);
        socketToRoom.delete(existingSocketId);

        // Если старый сокет ещё технически жив (не успел разорваться),
        // выводим его из комнаты socket.io, чтобы он не получал её события.
        const staleSocket = io.sockets.sockets.get(existingSocketId);
        if (staleSocket) {
          staleSocket.leave(room.id);
        }
      }
    }
  }

  function createRoom(socketId, rawPlayerName, rawSessionId) {
    const playerName = sanitizePlayerName(rawPlayerName);
    const sessionId = sanitizeSessionId(rawSessionId);

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
    if (room.players.size >= maxPlayers) {
      return { error: "full" };
    }
    if (room.status !== "waiting") {
      return { error: "started" };
    }

    // На случай повторного join-room тем же сокетом (двойной клик) —
    // убираем возможный дубль по sessionId перед добавлением.
    removeStaleSessionPlayers(room, sessionId, socketId);

    const player = createPlayer(
      socketId,
      sessionId,
      playerName || `Player${room.players.size + 1}`
    );
    room.players.set(socketId, player);
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
      // Убираем "призрачную" запись этого же человека под старым
      // socket.id, чтобы не получить дубликат при переходе с главной
      // страницы в комнату.
      removeStaleSessionPlayers(room, sessionId, socketId);

      player = createPlayer(
        socketId,
        sessionId,
        playerName || `Player${room.players.size + 1}`
      );
      room.players.set(socketId, player);
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

  function removePlayerBySocket(socketId) {
    const roomId = socketToRoom.get(socketId);
    if (!roomId) return null;

    const room = rooms.get(roomId);
    if (!room || !room.players.has(socketId)) return null;

    const player = room.players.get(socketId);
    if (player.isReady && room.readyCount > 0) {
      room.readyCount--;
    }
    room.players.delete(socketId);
    socketToRoom.delete(socketId);

    return { roomId, room, player };
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
    removePlayerBySocket,
    deleteRoomIfEmpty,
  };
}

module.exports = { createRoomService };
