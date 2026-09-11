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
    console.log("✅ User connected:", socket.id);

    // Идентификация комнаты при загрузке страницы комнаты
    socket.on("identify-room", (data) => {
      const roomId = data && data.roomId;

      if (!isValidRoomId(roomId)) {
        console.log("❌ Invalid roomId in identify-room:", roomId);
        socket.emit("error", "Комната не найдена");
        return;
      }

      console.log(`🔍 Identifying room for socket ${socket.id}: ${roomId}`);

      const result = roomService.identify(
        socket.id,
        roomId,
        data && data.playerName,
        data && data.sessionId
      );

      if (result.error) {
        console.log(`❌ Room not found for identification: ${roomId}`);
        socket.emit("error", "Комната не найдена");
        return;
      }

      socket.join(roomId);

      console.log(
        `✅ Socket ${socket.id} identified with room ${roomId}, player: ${result.player.name}`
      );

      socket.emit("room-info", roomService.getRoomInfo(result.room));
    });

    // Создание комнаты
    socket.on("create-room", (data) => {
      console.log("🎮 Creating room for player:", data && data.playerName);

      if (!soundScanner.hasSounds()) {
        socket.emit("error", "Игра готовится");
        return;
      }

      const { room, player } = roomService.createRoom(
        socket.id,
        data && data.playerName,
        data && data.sessionId
      );

      socket.join(room.id);

      console.log(
        `🎪 Room created: ${room.id}, Password: ${room.password}, Creator: ${player.name}`
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

      console.log("🔗 Join room attempt:", { roomPassword });

      // Защита от подбора пароля: ограничиваем частоту попыток на сокет
      if (joinRateLimiter.isRateLimited(socket.id)) {
        console.log("⛔ Rate limit exceeded for join-room:", socket.id);
        socket.emit("error", "Слишком много попыток, подождите немного");
        return;
      }

      if (!isValidRoomPassword(roomPassword)) {
        console.log("❌ Invalid room password format:", roomPassword);
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
        console.log("❌ Room not found for password:", roomPassword);
        socket.emit("error", "Комната не найдена");
        return;
      }
      if (result.error === "full") {
        console.log(`❌ Room full for password: ${roomPassword}`);
        socket.emit("error", "Комната заполнена!");
        return;
      }
      if (result.error === "started") {
        console.log("❌ Game already started for password:", roomPassword);
        socket.emit("error", "Игра уже началась");
        return;
      }

      socket.join(result.roomId);

      console.log(
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
      console.log(`🎯 Player ready: ${socket.id} in room ${roomId}`);

      const result = roomService.setPlayerReady(socket.id, roomId, true);

      if (result.error === "not_found") {
        console.log("❌ Room not found:", roomId);
        socket.emit("error", "Комната не найдена");
        return;
      }
      if (result.error === "player_not_found") {
        console.log("❌ Player not found in room:", socket.id);
        socket.emit("error", "Игрок не найден в комнате");
        return;
      }
      if (result.error === "started") {
        console.log("❌ Cannot set ready - game already started");
        socket.emit("error", "Игра уже началась");
        return;
      }

      if (result.changed) {
        console.log(
          `✅ Player ${result.player.name} is ready. Ready count: ${result.room.readyCount}/${result.room.players.size}`
        );

        socket.emit("ready-status-changed", { isReady: true });
        io.to(roomId).emit("room-info", roomService.getRoomInfo(result.room));

        // Проверяем, все ли готовы (минимум 2 игрока)
        if (
          result.room.readyCount === result.room.players.size &&
          result.room.players.size >= 2
        ) {
          console.log(
            `🚀 Starting game in room ${roomId} - all players ready!`
          );
          gameService.startGame(roomId);
        }
      }
    });

    // Отмена готовности
    socket.on("player-unready", (data) => {
      const roomId = data && data.roomId;
      console.log(`🎯 Player unready: ${socket.id} in room ${roomId}`);

      const result = roomService.setPlayerReady(socket.id, roomId, false);

      if (result.error === "not_found") {
        console.log("❌ Room not found:", roomId);
        socket.emit("error", "Комната не найдена");
        return;
      }
      if (result.error === "player_not_found") {
        console.log("❌ Player not found in room:", socket.id);
        socket.emit("error", "Игрок не найден в комнате");
        return;
      }
      if (result.error === "started") {
        console.log("❌ Cannot set unready - game already started");
        socket.emit("error", "Игра уже началась");
        return;
      }

      if (result.changed) {
        console.log(
          `❌ Player ${result.player.name} is not ready. Ready count: ${result.room.readyCount}/${result.room.players.size}`
        );

        socket.emit("ready-status-changed", { isReady: false });
        io.to(roomId).emit("room-info", roomService.getRoomInfo(result.room));
      }
    });

    // Голосование за предателя
    socket.on("vote-impostor", (data) => {
      const { roomId, votedPlayerId } = data || {};
      console.log(
        `🗳️ Vote from ${socket.id} for player ${votedPlayerId} in room ${roomId}`
      );

      const result = roomService.recordVote(roomId, socket.id, votedPlayerId);
      if (result.error) {
        console.log("❌ Voting not active, room or players not found");
        return;
      }

      console.log(
        `✅ ${result.voter.name} voted for ${result.votedPlayer.name}`
      );

      io.to(roomId).emit("voting-updated", {
        votedPlayers: result.votedPlayers,
        totalPlayers: result.room.players.size,
      });

      socket.emit("private-vote-update", { votedFor: votedPlayerId });

      if (result.allVoted) {
        console.log(`🏁 All players voted in room ${roomId}`);
        // Небольшая задержка перед показом результатов
        setTimeout(() => {
          gameService.showVotingResults(roomId);
        }, 1000);
      }
    });

    // Запрос информации о комнате
    socket.on("get-room-info", (data) => {
      const roomId = data && data.roomId;
      console.log(`📊 Room info requested for: ${roomId}`);

      const room = roomService.getRoom(roomId);
      if (room) {
        socket.emit("room-info", roomService.getRoomInfo(room));
      } else {
        console.log(`❌ Room not found: ${roomId}`);
        socket.emit("error", "Комната не найдена");
      }
    });

    // Отключение игрока
    socket.on("disconnect", () => {
      console.log("❌ User disconnected:", socket.id);

      // Чистим счётчик попыток подключения, чтобы не копить память
      joinRateLimiter.clear(socket.id);

      const removed = roomService.removePlayerBySocket(socket.id);
      if (!removed) return;

      const { roomId, room, player } = removed;
      console.log(`🗑️ Removing player ${player.name} from room ${roomId}`);

      // Удаляем комнату ТОЛЬКО через 5 секунд, чтобы дать время на переподключение
      if (room.players.size === 0 && room.status === "waiting") {
        console.log(`⏰ Scheduling room deletion in 5 seconds: ${roomId}`);
        setTimeout(() => {
          if (roomService.deleteRoomIfEmpty(roomId)) {
            console.log(`🏁 Deleting empty room: ${roomId}`);
          }
        }, 5000);
      } else if (room.players.size > 0) {
        io.to(roomId).emit("room-info", roomService.getRoomInfo(room));
      }
    });

    // Отмена голоса
    socket.on("cancel-vote", (data) => {
      const roomId = data && data.roomId;
      console.log(`🗑️ Cancel vote from ${socket.id} in room ${roomId}`);

      const result = roomService.cancelVote(roomId, socket.id);
      if (result.error) {
        console.log("❌ Voting not active or voter not found");
        return;
      }

      io.to(roomId).emit("voting-updated", {
        votedPlayers: result.votedPlayers,
        totalPlayers: result.room.players.size,
      });

      socket.emit("vote-cancelled");
    });
  });
}

module.exports = { registerSocketHandlers };
