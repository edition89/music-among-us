const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const SoundScanner = require("./utils/soundScanner");
const {
  MAX_PLAYERS,
  ROUND_DURATION,
  PREPARE_TIME,
  ROOM_ID_LENGTH,
} = require("./config/constants");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const soundScanner = new SoundScanner();

// Middleware
app.use(express.static("public"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Хранилище комнат
const rooms = new Map();
// Хранилище связей socket.id -> roomId
const socketToRoom = new Map();

// --- Валидация и защита от злоупотреблений ---

const MAX_NAME_LENGTH = 15;
const ROOM_PASSWORD_PATTERN = /^[A-Z0-9]{4}$/;
const ROOM_ID_PATTERN = new RegExp(`^[A-Z0-9]{${ROOM_ID_LENGTH}}$`);

// Убираем управляющие символы и обрезаем длину имени игрока.
// От XSS клиент защищается экранированием при рендере, но и на сервере
// не помешает не хранить откровенно "грязные" значения.
function sanitizePlayerName(rawName) {
  if (typeof rawName !== "string") return null;
  const cleaned = rawName
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

function isValidRoomId(roomId) {
  return typeof roomId === "string" && ROOM_ID_PATTERN.test(roomId);
}

function isValidRoomPassword(password) {
  return typeof password === "string" && ROOM_PASSWORD_PATTERN.test(password);
}

// Простой rate-limit попыток подключения к комнате по паролю:
// не более JOIN_ATTEMPT_LIMIT попыток за JOIN_ATTEMPT_WINDOW_MS на сокет,
// чтобы затруднить подбор 4-символьного пароля.
const JOIN_ATTEMPT_LIMIT = 10;
const JOIN_ATTEMPT_WINDOW_MS = 10000;
const joinAttempts = new Map(); // socket.id -> [timestamps]

function isRateLimited(socketId) {
  const now = Date.now();
  const attempts = (joinAttempts.get(socketId) || []).filter(
    (ts) => now - ts < JOIN_ATTEMPT_WINDOW_MS
  );
  attempts.push(now);
  joinAttempts.set(socketId, attempts);
  return attempts.length > JOIN_ATTEMPT_LIMIT;
}

// --- Дедупликация игроков при переходе index.html -> room.html ---
//
// Клиент использует ДВА разных socket.io-соединения: одно на главной
// странице (создание/подключение к комнате) и новое — на странице комнаты
// (identify-room). Когда браузер переходит по ссылке, старое соединение
// закрывается не мгновенно (иногда сервер узнаёт о разрыве только через
// несколько секунд), а новое уже успевает представиться в той же комнате.
// Из-за этого один и тот же человек на короткое (а иногда и не очень)
// время виден как два игрока с одинаковым именем.
//
// Чтобы это исправить, клиент передаёт "sessionId" — один раз
// сгенерированный идентификатор вкладки (хранится в sessionStorage) —
// во всех запросах create-room/join-room/identify-room. Перед тем как
// добавить игрока под новым socket.id, мы удаляем из комнаты любую
// "устаревшую" запись с тем же sessionId.
function sanitizeSessionId(rawSessionId) {
  if (typeof rawSessionId !== "string") return null;
  const cleaned = rawSessionId.trim().slice(0, 64);
  return /^[A-Za-z0-9-]{8,64}$/.test(cleaned) ? cleaned : null;
}

// Готовим список игроков для отправки клиентам: sessionId — внутренний
// технический идентификатор, его не должны видеть другие игроки.
function getPublicPlayers(room) {
  return Array.from(room.players.values()).map((p) => ({
    id: p.id,
    name: p.name,
    isReady: p.isReady,
    role: p.role,
    hasVoted: p.hasVoted,
    votedFor: p.votedFor,
  }));
}

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

// Генерация ID комнаты
function generateRoomId() {
  return Math.random()
    .toString(36)
    .substring(2, 2 + ROOM_ID_LENGTH)
    .toUpperCase();
}

// Генерация пароля из 4 символов
function generatePassword() {
  const chars = "ABCDEFGHIJKLMNPQRSTUVWXYZ123456789";
  let password = "";
  for (let i = 0; i < 4; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

// Маршруты
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "index.html"));
});

app.get("/room/:roomId", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "room.html"));
});

// Socket.io обработчики
io.on("connection", (socket) => {
  console.log("✅ User connected:", socket.id);

  // Обработчик для идентификации комнаты при загрузке страницы комнаты
  socket.on("identify-room", (data) => {
    const roomId = data && data.roomId;
    const playerName = sanitizePlayerName(data && data.playerName);
    const sessionId = sanitizeSessionId(data && data.sessionId);

    if (!isValidRoomId(roomId)) {
      console.log("❌ Invalid roomId in identify-room:", roomId);
      socket.emit("error", "Комната не найдена");
      return;
    }

    console.log(
      `🔍 Identifying room for socket ${socket.id}: ${roomId}, name: ${playerName}`
    );
    console.log(`📊 Available rooms:`, Array.from(rooms.keys()));

    const room = rooms.get(roomId);
    if (room) {
      // Проверяем, есть ли игрок с таким socket.id в комнате
      let player = room.players.get(socket.id);

      // Если игрок не найден, создаем нового с переданным именем
      if (!player) {
        // Убираем "призрачную" запись этого же человека под старым
        // socket.id (см. removeStaleSessionPlayers выше), чтобы не
        // получить дубликат при переходе с главной страницы в комнату.
        removeStaleSessionPlayers(room, sessionId, socket.id);

        player = {
          id: socket.id,
          sessionId,
          name: playerName || `Player${room.players.size + 1}`,
          isReady: false,
          role: "crewmate",
          hasVoted: false,
          votedFor: null,
        };
        room.players.set(socket.id, player);
        console.log(`👤 Created new player: ${player.name}`);
      } else {
        if (playerName && player.name !== playerName) {
          // Обновляем имя игрока если оно изменилось
          console.log(
            `✏️ Updating player name from ${player.name} to ${playerName}`
          );
          player.name = playerName;
        }
        if (sessionId && !player.sessionId) {
          player.sessionId = sessionId;
        }
      }

      socket.join(roomId);
      socketToRoom.set(socket.id, roomId);

      console.log(
        `✅ Socket ${socket.id} identified with room ${roomId}, player: ${player.name}`
      );
      console.log(
        `👥 Players in room now:`,
        Array.from(room.players.values()).map((p) => p.name)
      );

      // Отправляем информацию о комнате
      socket.emit("room-info", {
        password: room.password,
        players: getPublicPlayers(room),
        readyCount: room.readyCount,
        voting: room.voting,
        votes: room.votes,
        maxPlayers: MAX_PLAYERS,
      });
    } else {
      console.log(`❌ Room not found for identification: ${roomId}`);
      socket.emit("error", "Комната не найдена");
    }
  });

  // Создание комнаты
  socket.on("create-room", (data) => {
    const playerName = sanitizePlayerName(data && data.playerName);
    const sessionId = sanitizeSessionId(data && data.sessionId);
    console.log("🎮 Creating room for player:", playerName);

    if (!soundScanner.hasSounds()) {
      socket.emit("error", "Игра готовится");
      return;
    }

    const roomId = generateRoomId();
    const password = generatePassword();
    const room = {
      id: roomId,
      password: password,
      players: new Map(),
      readyCount: 0,
      status: "waiting",
      impostor: null,
      currentSounds: null,
      voting: false,
      votes: {},
      createdAt: Date.now(),
      maxPlayers: MAX_PLAYERS, // Сохраняем максимальное количество игроков
    };

    // Добавляем создателя в комнату
    const player = {
      id: socket.id,
      sessionId,
      name: playerName || `Player1`,
      isReady: false,
      role: "crewmate",
      hasVoted: false,
      votedFor: null,
    };

    room.players.set(socket.id, player);
    rooms.set(roomId, room);
    socketToRoom.set(socket.id, roomId);

    socket.join(roomId);

    console.log(
      `🎪 Room created: ${roomId}, Password: ${password}, Creator: ${player.name}`
    );
    console.log(`📊 Rooms count: ${rooms.size}`);
    console.log(`📊 Current rooms:`, Array.from(rooms.keys()));

    // Сразу отправляем информацию о комнате создателю
    socket.emit("room-info", {
      password: room.password,
      players: getPublicPlayers(room),
      readyCount: room.readyCount,
      voting: room.voting,
      votes: room.votes,
      maxPlayers: MAX_PLAYERS,
    });

    // Ждем немного перед редиректом, чтобы комната точно создалась
    setTimeout(() => {
      socket.emit("room-created", {
        roomId: roomId,
        password: password,
      });
    }, 100);
  });

  // Подключение к комнате
  socket.on("join-room", (data) => {
    const roomPassword =
      data && typeof data.roomPassword === "string"
        ? data.roomPassword.toUpperCase().trim()
        : "";
    const playerName = sanitizePlayerName(data && data.playerName);
    const sessionId = sanitizeSessionId(data && data.sessionId);

    console.log("🔗 Join room attempt:", { roomPassword, playerName });

    // Защита от подбора пароля: ограничиваем частоту попыток на сокет
    if (isRateLimited(socket.id)) {
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

    // Находим комнату по паролю
    let targetRoom = null;
    let targetRoomId = null;

    for (const [roomId, room] of rooms.entries()) {
      if (room.password === roomPassword) {
        targetRoom = room;
        targetRoomId = roomId;
        break;
      }
    }

    if (!targetRoom) {
      console.log("❌ Room not found for password:", roomPassword);
      socket.emit("error", "Комната не найдена");
      return;
    }

    // Используем MAX_PLAYERS из констант
    if (targetRoom.players.size >= MAX_PLAYERS) {
      console.log(
        `❌ Room full: ${targetRoomId} (${targetRoom.players.size}/${MAX_PLAYERS})`
      );
      socket.emit("error", `Комната заполнена!`);
      return;
    }

    if (targetRoom.status !== "waiting") {
      console.log("❌ Game already started:", targetRoomId);
      socket.emit("error", "Игра уже началась");
      return;
    }

    // На случай повторного join-room тем же сокетом (двойной клик) —
    // убираем возможный дубль по sessionId перед добавлением.
    removeStaleSessionPlayers(targetRoom, sessionId, socket.id);

    // Добавляем игрока
    const player = {
      id: socket.id,
      sessionId,
      name: playerName || `Player${targetRoom.players.size + 1}`,
      isReady: false,
      role: "crewmate",
      hasVoted: false,
      votedFor: null,
    };

    targetRoom.players.set(socket.id, player);
    socket.join(targetRoomId);
    socketToRoom.set(socket.id, targetRoomId);

    console.log(`✅ Player ${player.name} joined room ${targetRoomId}`);
    console.log(
      `👥 Players in room: ${targetRoom.players.size}/${MAX_PLAYERS}`
    );

    socket.emit("room-joined", {
      roomId: targetRoomId,
    });

    // Обновляем список игроков для всех в комнате
    io.to(targetRoomId).emit("room-info", {
      password: targetRoom.password,
      players: getPublicPlayers(targetRoom),
      readyCount: targetRoom.readyCount,
      voting: targetRoom.voting,
      votes: targetRoom.votes,
      maxPlayers: MAX_PLAYERS, // Добавляем информацию о максимальном количестве игроков
    });
  });

  // Готовность игрока
  socket.on("player-ready", (data) => {
    const { roomId } = data;
    const room = rooms.get(roomId);

    console.log(`🎯 Player ready: ${socket.id} in room ${roomId}`);

    if (!room) {
      console.log("❌ Room not found:", roomId);
      socket.emit("error", "Комната не найдена");
      return;
    }

    const player = room.players.get(socket.id);
    if (!player) {
      console.log("❌ Player not found in room:", socket.id);
      socket.emit("error", "Игрок не найден в комнате");
      return;
    }

    if (room.status !== "waiting") {
      console.log("❌ Cannot set ready - game already started");
      socket.emit("error", "Игра уже началась");
      return;
    }

    if (!player.isReady) {
      player.isReady = true;
      room.readyCount++;

      console.log(
        `✅ Player ${player.name} is ready. Ready count: ${room.readyCount}/${room.players.size}`
      );

      socket.emit("ready-status-changed", { isReady: true });

      // Обновляем информацию о комнате
      io.to(roomId).emit("room-info", {
        password: room.password,
        players: getPublicPlayers(room),
        readyCount: room.readyCount,
        voting: room.voting,
        votes: room.votes,
        maxPlayers: MAX_PLAYERS,
      });

      // Проверяем, все ли готовы (минимум 2 игрока)
      if (room.readyCount === room.players.size && room.players.size >= 2) {
        console.log(`🚀 Starting game in room ${roomId} - all players ready!`);
        startGame(roomId);
      }
    }
  });

  // Отмена готовности
  socket.on("player-unready", (data) => {
    const { roomId } = data;
    const room = rooms.get(roomId);

    console.log(`🎯 Player unready: ${socket.id} in room ${roomId}`);

    if (!room) {
      console.log("❌ Room not found:", roomId);
      socket.emit("error", "Комната не найдена");
      return;
    }

    const player = room.players.get(socket.id);
    if (!player) {
      console.log("❌ Player not found in room:", socket.id);
      socket.emit("error", "Игрок не найден в комнате");
      return;
    }

    if (room.status !== "waiting") {
      console.log("❌ Cannot set unready - game already started");
      socket.emit("error", "Игра уже началась");
      return;
    }

    if (player.isReady) {
      player.isReady = false;
      room.readyCount--;

      console.log(
        `❌ Player ${player.name} is not ready. Ready count: ${room.readyCount}/${room.players.size}`
      );

      socket.emit("ready-status-changed", { isReady: false });

      // Обновляем информацию о комнате
      io.to(roomId).emit("room-info", {
        password: room.password,
        players: getPublicPlayers(room),
        readyCount: room.readyCount,
        voting: room.voting,
        votes: room.votes,
        maxPlayers: MAX_PLAYERS,
      });
    }
  });

  // Голосование за предателя
  socket.on("vote-impostor", (data) => {
    const { roomId, votedPlayerId } = data;
    const room = rooms.get(roomId);

    console.log(
      `🗳️ Vote from ${socket.id} for player ${votedPlayerId} in room ${roomId}`
    );

    if (!room || !room.voting) {
      console.log("❌ Voting not active or room not found");
      return;
    }

    const voter = room.players.get(socket.id);
    const votedPlayer = room.players.get(votedPlayerId);

    if (!voter || !votedPlayer) {
      console.log("❌ Voter or voted player not found");
      return;
    }

    // Если игрок уже голосовал, убираем его предыдущий голос
    if (voter.hasVoted && voter.votedFor) {
      console.log(
        `🔄 Player ${voter.name} changing vote from ${voter.votedFor} to ${votedPlayerId}`
      );

      // Уменьшаем счетчик предыдущего выбора
      if (room.votes[voter.votedFor]) {
        room.votes[voter.votedFor]--;
        if (room.votes[voter.votedFor] <= 0) {
          delete room.votes[voter.votedFor];
        }
      }
    }

    // Записываем новый голос
    voter.hasVoted = true;
    voter.votedFor = votedPlayerId;

    if (!room.votes[votedPlayerId]) {
      room.votes[votedPlayerId] = 0;
    }
    room.votes[votedPlayerId]++;

    console.log(
      `✅ ${voter.name} voted for ${votedPlayer.name}. Votes:`,
      room.votes
    );

    // Собираем информацию о проголосовавших игроках
    const votedPlayers = Array.from(room.players.values())
      .filter((p) => p.hasVoted)
      .map((p) => ({
        id: p.id,
        name: p.name,
      }));

    // Отправляем обновленную информацию о голосовании ВСЕМ игрокам
    io.to(roomId).emit("voting-updated", {
      votedPlayers: votedPlayers,
      totalPlayers: room.players.size,
    });

    // Отправляем приватную информацию о выборе только самому голосовавшему
    socket.emit("private-vote-update", {
      votedFor: votedPlayerId,
    });

    // Проверяем, все ли проголосовали
    const allVoted = Array.from(room.players.values()).every(
      (player) => player.hasVoted
    );
    if (allVoted) {
      console.log(`🏁 All players voted in room ${roomId}`);
      // Небольшая задержка перед показом результатов
      setTimeout(() => {
        showVotingResults(roomId);
      }, 1000);
    }
  });

  // Запрос информации о комнате
  socket.on("get-room-info", (data) => {
    const { roomId } = data;
    const room = rooms.get(roomId);

    console.log(`📊 Room info requested for: ${roomId}`);

    if (room) {
      console.log(`✅ Room found, sending info for room: ${roomId}`);
      socket.emit("room-info", {
        password: room.password,
        players: getPublicPlayers(room),
        readyCount: room.readyCount,
        voting: room.voting,
        votes: room.votes,
        maxPlayers: MAX_PLAYERS,
      });
    } else {
      console.log(`❌ Room not found: ${roomId}`);
      socket.emit("error", "Комната не найдена");
    }
  });

  // Отключение игрока
  // Отключение игрока
  socket.on("disconnect", () => {
    console.log("❌ User disconnected:", socket.id);

    // Чистим счётчик попыток подключения, чтобы не копить память
    joinAttempts.delete(socket.id);

    const roomId = socketToRoom.get(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      if (room && room.players.has(socket.id)) {
        const player = room.players.get(socket.id);

        console.log(`🗑️ Removing player ${player.name} from room ${roomId}`);

        if (player.isReady) {
          room.readyCount--;
        }

        room.players.delete(socket.id);
        socketToRoom.delete(socket.id);

        // Удаляем комнату ТОЛЬКО через 5 секунд, чтобы дать время на переподключение
        if (room.players.size === 0 && room.status === "waiting") {
          console.log(`⏰ Scheduling room deletion in 5 seconds: ${roomId}`);
          setTimeout(() => {
            // Проверяем, что комната все еще пустая
            const roomToDelete = rooms.get(roomId);
            if (roomToDelete && roomToDelete.players.size === 0) {
              console.log(`🏁 Deleting empty room: ${roomId}`);
              rooms.delete(roomId);
            }
          }, 5000);
        } else if (room.players.size > 0) {
          // Обновляем оставшихся игроков
          io.to(roomId).emit("room-info", {
            password: room.password,
            players: getPublicPlayers(room),
            readyCount: room.readyCount,
            voting: room.voting,
            votes: room.votes,
            maxPlayers: MAX_PLAYERS,
          });
        }
      }
    }
  });

  socket.on("cancel-vote", (data) => {
    const { roomId } = data;
    const room = rooms.get(roomId);

    console.log(`🗑️ Cancel vote from ${socket.id} in room ${roomId}`);

    if (!room || !room.voting) {
      console.log("❌ Voting not active or room not found");
      return;
    }

    const voter = room.players.get(socket.id);
    if (!voter || !voter.hasVoted) {
      console.log("❌ Voter not found or not voted");
      return;
    }

    // Убираем голос
    if (voter.votedFor && room.votes[voter.votedFor]) {
      room.votes[voter.votedFor]--;
      if (room.votes[voter.votedFor] <= 0) {
        delete room.votes[voter.votedFor];
      }
    }

    voter.hasVoted = false;
    voter.votedFor = null;

    console.log(`✅ ${voter.name} cancelled vote. Votes:`, room.votes);

    // Собираем обновленную информацию о проголосовавших
    const votedPlayers = Array.from(room.players.values())
      .filter((p) => p.hasVoted)
      .map((p) => ({
        id: p.id,
        name: p.name,
      }));

    // Отправляем обновленную информацию
    io.to(roomId).emit("voting-updated", {
      votedPlayers: votedPlayers,
      totalPlayers: room.players.size,
    });

    // Уведомляем об отмене голоса
    socket.emit("vote-cancelled");
  });
});

// Запуск игры
function startGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    console.log(`❌ Cannot start game - room not found: ${roomId}`);
    return;
  }

  console.log(`🎮 Starting game in room: ${roomId}`);
  room.status = "preparing";

  // Выбираем предателя
  const playersArray = Array.from(room.players.values());
  const impostorIndex = Math.floor(Math.random() * playersArray.length);
  const impostor = playersArray[impostorIndex];

  room.impostor = impostor.id;
  impostor.role = "impostor";

  console.log(`🎭 Impostor selected: ${impostor.name}`);

  // Выбираем музыку
  room.currentSounds = {
    impostor: soundScanner.getRandomImpostorSound(),
    crewmate: soundScanner.getRandomCrewmateSound(),
    countdown: soundScanner.getCountdownSound(),
    roundEnd: soundScanner.getRoundEndSound(),
  };

  console.log(`🎵 Sounds selected:`, room.currentSounds);

  // Воспроизводим звук отсчета для всех
  if (room.currentSounds.countdown) {
    console.log(`🔊 Playing countdown sound in room: ${roomId}`);
    io.to(roomId).emit("play-countdown", {
      sound: room.currentSounds.countdown,
      prepareTime: PREPARE_TIME,
    });
  }

  // Уведомляем о начале подготовки с счетчиком
  let countdown = PREPARE_TIME / 1000;
  io.to(roomId).emit("game-starting", {
    prepareTime: PREPARE_TIME,
    countdown: countdown,
  });

  // Запускаем счетчик обратного отсчета
  const countdownInterval = setInterval(() => {
    countdown--;
    if (countdown > 0) {
      io.to(roomId).emit("countdown-update", { countdown: countdown });
    } else {
      clearInterval(countdownInterval);
    }
  }, 1000);

  // Через время подготовки начинаем игру
  setTimeout(() => {
    room.status = "playing";

    console.log(`🎵 Playing music in room: ${roomId}`);

    // Отправляем музыку каждому игроку
    room.players.forEach((player, playerId) => {
      const sound =
        player.role === "impostor"
          ? room.currentSounds.impostor
          : room.currentSounds.crewmate;

      console.log(
        `🔊 Sending sound to ${player.name} (${player.role}): ${sound}`
      );

      io.to(playerId).emit("play-music", {
        sound,
        role: player.role,
        duration: ROUND_DURATION,
      });
    });

    // Завершаем игру через указанное время
    setTimeout(() => {
      endGame(roomId);
    }, ROUND_DURATION);
  }, PREPARE_TIME);
}

// Завершение игры
function endGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  console.log(`🏁 Ending game in room: ${roomId}`);

  room.status = "waiting";
  room.readyCount = 0;

  // Сбрасываем готовность всех игроков
  room.players.forEach((player) => {
    player.isReady = false;
    player.role = "crewmate";
  });

  // Воспроизводим звук завершения раунда
  if (room.currentSounds && room.currentSounds.roundEnd) {
    console.log(`🔊 Playing round end sound in room: ${roomId}`);
    io.to(roomId).emit("play-round-end", {
      sound: room.currentSounds.roundEnd,
    });
  }

  // Начинаем голосование
  startVoting(roomId);
}

// Начало голосования
function startVoting(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  console.log(`🗳️ Starting voting in room: ${roomId}`);

  room.voting = true;
  room.votes = {};

  // Сбрасываем статус голосования у всех игроков
  room.players.forEach((player) => {
    player.hasVoted = false;
    player.votedFor = null;
  });

  // Собираем начальную информацию о голосовании
  const votedPlayers = Array.from(room.players.values())
    .filter((p) => p.hasVoted)
    .map((p) => ({
      id: p.id,
      name: p.name,
    }));

  // Уведомляем о начале голосования
  io.to(roomId).emit("voting-started", {
    players: getPublicPlayers(room),
    votedPlayers: votedPlayers,
  });

  // Обновляем информацию о комнате
  io.to(roomId).emit("room-info", {
    password: room.password,
    players: getPublicPlayers(room),
    readyCount: room.readyCount,
    voting: room.voting,
    votes: room.votes,
    maxPlayers: MAX_PLAYERS,
  });
}

// Показ результатов голосования
function showVotingResults(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  console.log(`📊 Showing voting results for room: ${roomId}`);

  // Собираем результаты голосования для каждого игрока
  const votingResults = {};
  room.players.forEach((player) => {
    if (player.votedFor) {
      votingResults[player.id] = {
        voterName: player.name,
        votedFor: player.votedFor,
        votedForName: room.players.get(player.votedFor)?.name,
      };
    }
  });

  // Находим игрока с наибольшим количеством голосов
  let maxVotes = 0;
  let suspectedImpostorId = null;
  let tie = false;

  for (const [playerId, votes] of Object.entries(room.votes)) {
    if (votes > maxVotes) {
      maxVotes = votes;
      suspectedImpostorId = playerId;
      tie = false;
    } else if (votes === maxVotes && maxVotes > 0) {
      tie = true;
    }
  }

  const suspectedImpostor = suspectedImpostorId
    ? room.players.get(suspectedImpostorId)
    : null;
  const actualImpostor = room.impostor ? room.players.get(room.impostor) : null;

  console.log(
    `🎭 Voting results - Suspected: ${suspectedImpostor?.name}, Actual: ${actualImpostor?.name}, Tie: ${tie}`
  );

  // Завершаем голосование
  room.voting = false;
  room.votes = {};

  // Отправляем результаты
  io.to(roomId).emit("voting-results", {
    suspectedImpostor: suspectedImpostor,
    actualImpostor: actualImpostor,
    votes: room.votes,
    votingResults: votingResults,
    wasCorrect: !tie && suspectedImpostorId === room.impostor,
    wasTie: tie,
  });

  // Обновляем информацию о комнате
  io.to(roomId).emit("room-info", {
    password: room.password,
    players: getPublicPlayers(room),
    readyCount: room.readyCount,
    voting: room.voting,
    votes: room.votes,
    maxPlayers: MAX_PLAYERS,
  });

  // Сбрасываем impostor для следующего раунда
  room.impostor = null;

  // Сбрасываем статус голосования у всех игроков
  room.players.forEach((player) => {
    player.hasVoted = false;
    player.votedFor = null;
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("🔊 Available sounds:", {
    impostor: soundScanner.sounds.impostor.length,
    crewmate: soundScanner.sounds.crewmate.length,
    countdown: !!soundScanner.sounds.countdown,
    roundEnd: !!soundScanner.sounds.roundEnd,
  });

  if (!soundScanner.hasSounds()) {
    console.warn(
      "⚠️ WARNING: No sounds found! Please add sound files to public/sounds/ folders"
    );
  }
});
