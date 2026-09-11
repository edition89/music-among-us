const logger = require("../../utils/logger");
const {
  isValidRoomId,
  isValidRoomPassword,
} = require("../schemas/validation");

// Регистрирует все socket.io-обработчики. Сам контроллер не хранит
// никакого состояния — он только валидирует вход, зовёт roomService/
// gameService и решает, какое событие отправить клиенту в ответ.
function registerSocketHandlers(
  io,
  { roomService, gameService, soundScanner, joinRateLimiter }
) {
  io.on("connection", (socket) => {
    logger.debug("✅ User connected:", socket.id);

    // Идентификация комнаты при загрузке страницы комнаты (в том числе
    // повторно — после обрыва связи и автопереподключения socket.io).
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

      // Если игрок вернулся во время активного раунда/голосования —
      // остальные тоже должны увидеть, что он снова на связи.
      io.to(roomId).emit("room-info", roomService.getRoomInfo(result.room));
    });

    // Создание комнаты
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

      // Сразу отправляем информацию о комнате создателю
      socket.emit("room-info", roomService.getRoomInfo(room));

      // Ждём немного перед редиректом, чтобы комната точно создалась
      setTimeout(() => {
        socket.emit("room-created", {
          roomId: room.id,
          password: room.password,
        });
      }, 100);
    });

    // Подключение к комнате
    socket.on("join-room", (data) => {
      const roomPassword =
        data && typeof data.roomPassword === "string"
          ? data.roomPassword.toUpperCase().trim()
          : "";

      logger.debug("🔗 Join room attempt:", { roomPassword });

      // Защита от подбора пароля: ограничиваем частоту попыток на сокет
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

      // Обновляем список игроков для всех в комнате
      io.to(result.roomId).emit(
        "room-info",
        roomService.getRoomInfo(result.room)
      );
    });

    // Готовность игрока
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

        // Проверяем, все ли готовы (минимум 2 игрока)
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

    // Отмена готовности
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

    // Голосование за предателя
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
        // Небольшая задержка перед показом результатов
        setTimeout(() => {
          gameService.showVotingResults(roomId);
        }, 1000);
      }
    });

    // Запрос информации о комнате
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

    // Отключение игрока
    socket.on("disconnect", () => {
      logger.debug("❌ User disconnected:", socket.id);

      // Чистим счётчик попыток подключения, чтобы не копить память
      joinRateLimiter.clear(socket.id);

      const result = roomService.handleDisconnect(socket.id, (expired) => {
        // Сработало, если игрок не переподключился за отведённое время
        // (см. DISCONNECT_GRACE_MS в roomService) — досрочно, ДО этого
        // колбэка, ничего клиентам не отправлялось.
        finalizePlayerRemoval(expired.roomId, expired.room);
      });

      if (!result) return;

      const { roomId, room, permanentlyRemoved } = result;

      if (permanentlyRemoved) {
        finalizePlayerRemoval(roomId, room);
      } else {
        // Игрок пока не удалён — просто сообщаем остальным, что он
        // временно не на связи (см. connected:false в payload игрока).
        io.to(roomId).emit("room-info", roomService.getRoomInfo(room));
      }
    });

    // Отмена голоса
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

    // Общая логика для "игрок окончательно ушёл из комнаты" — вызывается
    // и сразу при disconnect в лобби, и по истечении грейс-периода во
    // время активного раунда.
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

        // Если ушедший был последним, кто не проголосовал — голосование
        // теперь должно завершиться само.
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
