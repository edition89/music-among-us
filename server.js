const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const path = require("path");

const SoundScanner = require("./utils/soundScanner");
const {
  MAX_PLAYERS,
  ROUND_DURATION,
  PREPARE_TIME,
  ROOM_ID_LENGTH,
} = require("./config/constants");

const { createRoomService } = require("./server/services/roomService");
const { createGameService } = require("./server/services/gameService");
const {
  registerSocketHandlers,
} = require("./server/controllers/socketController");
const { createRateLimiter } = require("./server/middleware/rateLimiter");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const soundScanner = new SoundScanner();

// Middleware
app.use(express.static("public"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Маршруты
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "index.html"));
});

app.get("/room/:roomId", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "room.html"));
});

// Сервисы: roomService хранит комнаты/игроков и меняет их состояние,
// gameService управляет ходом раунда (старт игры, голосование, результаты).
const roomService = createRoomService(io, {
  maxPlayers: MAX_PLAYERS,
  roomIdLength: ROOM_ID_LENGTH,
});

const gameService = createGameService(io, roomService, soundScanner, {
  PREPARE_TIME,
  ROUND_DURATION,
});

// Защита от подбора 4-символьного пароля комнаты: не более 10 попыток
// join-room за 10 секунд с одного сокета.
const joinRateLimiter = createRateLimiter(10, 10000);

registerSocketHandlers(io, {
  roomService,
  gameService,
  soundScanner,
  joinRateLimiter,
});

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
