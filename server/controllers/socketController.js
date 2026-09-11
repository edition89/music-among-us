const logger = require("../../utils/logger");
const {
  isValidRoomId,
  isValidRoomPassword,
} = require("../schemas/validation");

function registerSocketHandlers(
  io,
  { roomService, gameService, soundScanner, joinRateLimiter }
) {
  io.on("connection", (socket) => {
    logger.debug("✅ User connected:", socket.id);

    socket.on("identify-room", (data) => {
      const roomId = data && data.roomId;

      if (!isValidRoomId(roomId)) {
        logger.debug("❌ Invalid roomId in identify-room:", roomId);
        socket.emit("error", "Комната не найдена");
        return;
      }

      logger.debug(`🔍 Identifying room for socket ${socket.id}: ${roomId}`);

      const result = roomService.identify(
        socket.id,
        roomId,
        data && data.playerName,
        data && data.sessionId
      );

      if (result.error) {
        logger.debug(`❌ Room not found for identification: ${roomId}`);
        socket.emit("error", "Комната не найдена");
        return;
      }

      socket.join(roomId);

      logger.debug(
        `✅ Socket ${socket.id} identified with room ${roomId}, player: ${result.player.name}`
      );

      socket.emit("room-info", roomService.getRoomInfo(result.room));

      io.to(roomId).emit("room-info", roomService.getRoomInfo(result.room));
    });

    socket.on("create-room", (data) => {
      logger.debug("🎮 Creating room for player:", data && data.playerName);

      if (!soundScanner.hasSounds()) {
        socket.emit("error", "Игра готовится");
        return;
      }

      const { room, player } = roomService.createRoom(
        socket.id,
        data && data.playerName,
        data && data.sessionId,
        data && data.maxPlayers,
        data && data.roundDuration
      );

      socket.join(room.id);

      logger.debug(
        `🎪 Room created: ${room.id}, Password: ${room.password}, Creator: ${player.name}, maxPlayers: ${room.maxPlayers}, roundDuration: ${room.roundDuration}ms`
      );

      socket.emit("room-info", roomService.getRoomInfo(room));

      setTimeout(() => {
        socket.emit("room-created", {
          roomId: room.id,
          password: room.password,
        });
      }, 100);
    });

    socket.on("join-room", (data) => {
      const roomPassword =
        data && typeof data.roomPassword === "string"
          ? data.roomPassword.toUpperCase().trim()
          : "";

      logger.debug("🔗 Join room attempt:", { roomPassword });

      if (joinRateLimiter.isRateLimited(socket.id)) {
        logger.debug("⛔ Rate limit exceeded for join-room:", socket.id);
        socket.emit("error", "Слишком много попыток, подождите немного");
        return;
      }

      if (!isValidRoomPassword(roomPassword)) {
        logger.debug("❌ Invalid room password format:", roomPassword);
        socket.emit("error", "Комната не найдена");
        return;
      }

      if (!soundScanner.hasSounds()) {
        socket.emit("error", "Игра готовится");
        return;
      }

      const result = roomService.joinRoom(
        socket.id,
        roomPassword,
        data && data.playerName,
        data && data.sessionId
      );

      if (result.error === "not_found") {
        logger.debug("❌ Room not found for password:", roomPassword);
        socket.emit("error", "Комната не найдена");
        return;
      }
      if (result.error === "full") {
        logger.debug(`❌ Room full for password: ${roomPassword}`);
        socket.emit("error", "Комната заполнена!");
        return;
      }
      if (result.error === "started") {
        logger.debug("❌ Game already started for password:", roomPassword);
        socket.emit("error", "Игра уже началась");
        return;
      }

      socket.join(result.roomId);

      logger.debug(
        `✅ Player ${result.player.name} joined room ${result.roomId}`
      );

      socket.emit("room-joined", { roomId: result.roomId });

      io.to(result.roomId).emit(
        "room-info",
        roomService.getRoomInfo(result.room)
      );
    });

    socket.on("player-ready", (data) => {
      const roomId = data && data.roomId;
      logger.debug(`🎯 Player ready: ${socket.id} in room ${roomId}`);

      const result = roomService.setPlayerReady(socket.id, roomId, true);

      if (result.error === "not_found") {
        logger.debug("❌ Room not found:", roomId);
        socket.emit("error", "Комната не найдена");
        return;
      }
      if (result.error === "player_not_found") {
        logger.debug("❌ Player not found in room:", socket.id);
        socket.emit("error", "Игрок не найден в комнате");
        return;
      }
      if (result.error === "started") {
        logger.debug("❌ Cannot set ready - game already started");
        socket.emit("error", "Игра уже началась");
        return;
      }

      if (result.changed) {
        logger.debug(
          `✅ Player ${result.player.name} is ready. Ready count: ${result.room.readyCount}/${result.room.players.size}`
        );

        socket.emit("ready-status-changed", { isReady: true });
        io.to(roomId).emit("room-info", roomService.getRoomInfo(result.room));

        if (
          result.room.readyCount === result.room.players.size &&
          result.room.players.size >= 2
        ) {
          logger.debug(
            `🚀 Starting game in room ${roomId} - all players ready!`
          );
          gameService.startGame(roomId);
        }
      }
    });

    socket.on("player-unready", (data) => {
      const roomId = data && data.roomId;
      logger.debug(`🎯 Player unready: ${socket.id} in room ${roomId}`);

      const result = roomService.setPlayerReady(socket.id, roomId, false);

      if (result.error === "not_found") {
        logger.debug("❌ Room not found:", roomId);
        socket.emit("error", "Комната не найдена");
        return;
      }
      if (result.error === "player_not_found") {
        logger.debug("❌ Player not found in room:", socket.id);
        socket.emit("error", "Игрок не найден в комнате");
        return;
      }
      if (result.error === "started") {
        logger.debug("❌ Cannot set unready - game already started");
        socket.emit("error", "Игра уже началась");
        return;
      }

      if (result.changed) {
        logger.debug(
          `❌ Player ${result.player.name} is not ready. Ready count: ${result.room.readyCount}/${result.room.players.size}`
        );

        socket.emit("ready-status-changed", { isReady: false });
        io.to(roomId).emit("room-info", roomService.getRoomInfo(result.room));
      }
    });

    socket.on("vote-impostor", (data) => {
      const { roomId, votedPlayerId } = data || {};
      logger.debug(
        `🗳️ Vote from ${socket.id} for player ${votedPlayerId} in room ${roomId}`
      );

      const result = roomService.recordVote(roomId, socket.id, votedPlayerId);
      if (result.error) {
        logger.debug("❌ Voting not active, room or players not found");
        return;
      }

      logger.debug(
        `✅ ${result.voter.name} voted for ${result.votedPlayer.name}`
      );

      io.to(roomId).emit("voting-updated", {
        votedPlayers: result.votedPlayers,
        totalPlayers: result.room.players.size,
      });

      socket.emit("private-vote-update", { votedFor: votedPlayerId });

      if (result.allVoted) {
        logger.debug(`🏁 All players voted in room ${roomId}`);

        setTimeout(() => {
          gameService.showVotingResults(roomId);
        }, 1000);
      }
    });

    socket.on("get-room-info", (data) => {
      const roomId = data && data.roomId;
      logger.debug(`📊 Room info requested for: ${roomId}`);

      const room = roomService.getRoom(roomId);
      if (room) {
        socket.emit("room-info", roomService.getRoomInfo(room));
      } else {
        logger.debug(`❌ Room not found: ${roomId}`);
        socket.emit("error", "Комната не найдена");
      }
    });

    socket.on("disconnect", () => {
      logger.debug("❌ User disconnected:", socket.id);

      joinRateLimiter.clear(socket.id);

      const result = roomService.handleDisconnect(socket.id, (expired) => {

        finalizePlayerRemoval(expired.roomId, expired.room);
      });

      if (!result) return;

      const { roomId, room, permanentlyRemoved } = result;

      if (permanentlyRemoved) {
        finalizePlayerRemoval(roomId, room);
      } else {

        io.to(roomId).emit("room-info", roomService.getRoomInfo(room));
      }
    });

    socket.on("cancel-vote", (data) => {
      const roomId = data && data.roomId;
      logger.debug(`🗑️ Cancel vote from ${socket.id} in room ${roomId}`);

      const result = roomService.cancelVote(roomId, socket.id);
      if (result.error) {
        logger.debug("❌ Voting not active or voter not found");
        return;
      }

      io.to(roomId).emit("voting-updated", {
        votedPlayers: result.votedPlayers,
        totalPlayers: result.room.players.size,
      });

      socket.emit("vote-cancelled");
    });

    function finalizePlayerRemoval(roomId, room) {
      if (room.players.size === 0 && room.status === "waiting") {
        logger.debug(`⏰ Scheduling room deletion in 5 seconds: ${roomId}`);
        setTimeout(() => {
          if (roomService.deleteRoomIfEmpty(roomId)) {
            logger.debug(`🏁 Deleting empty room: ${roomId}`);
          }
        }, 5000);
        return;
      }

      if (room.players.size > 0) {
        io.to(roomId).emit("room-info", roomService.getRoomInfo(room));

        if (
          room.voting &&
          Array.from(room.players.values()).every((p) => p.hasVoted)
        ) {
          logger.debug(
            `🏁 All remaining players voted after a disconnect in room ${roomId}`
          );
          setTimeout(() => {
            gameService.showVotingResults(roomId);
          }, 1000);
        }
      }
    }
  });
}

module.exports = { registerSocketHandlers };
