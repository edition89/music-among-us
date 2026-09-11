const logger = require("../../utils/logger");
const {
  sanitizePlayerName,
  sanitizeSessionId,
  sanitizeMaxPlayers,
  sanitizeRoundDurationMs,
} = require("../schemas/validation");

const DISCONNECT_GRACE_MS = 20000;

function createRoomService(io, { roomIdLength }) {
  const rooms = new Map();
  const socketToRoom = new Map();

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

  function isRoundActive(room) {
    return (
      room.status === "preparing" || room.status === "playing" || room.voting
    );
  }

  function reclaimStalePlayer(room, sessionId, newSocketId, playerName) {
    if (!sessionId) return null;

    for (const [oldSocketId, existingPlayer] of room.players.entries()) {
      if (oldSocketId === newSocketId) continue;
      if (existingPlayer.sessionId !== sessionId) continue;

      logger.debug(
        `♻️ Reclaiming session for ${existingPlayer.name}: ${oldSocketId} -> ${newSocketId}`
      );

      clearDisconnectTimer(existingPlayer);

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
