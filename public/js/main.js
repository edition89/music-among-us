const socket = io();

function getOrCreatePlayerSessionId() {
  let sessionId = sessionStorage.getItem("playerSessionId");
  if (!sessionId) {
    sessionId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem("playerSessionId", sessionId);
  }
  return sessionId;
}

document.getElementById("createRoomBtn").addEventListener("click", () => {
  document.getElementById("createRoomForm").classList.remove("hidden");
  document.getElementById("joinRoomForm").classList.add("hidden");
  document.getElementById("playerNameCreate").focus();
});

document.getElementById("joinRoomBtn").addEventListener("click", () => {
  document.getElementById("joinRoomForm").classList.remove("hidden");
  document.getElementById("createRoomForm").classList.add("hidden");
  document.getElementById("joinRoomPassword").focus();
});

const maxPlayersInput = document.getElementById("maxPlayersInput");
const maxPlayersValue = document.getElementById("maxPlayersValue");
const roundDurationInput = document.getElementById("roundDurationInput");
const roundDurationValue = document.getElementById("roundDurationValue");

if (maxPlayersInput) {
  maxPlayersInput.addEventListener("input", () => {
    maxPlayersValue.textContent = Math.round(Number(maxPlayersInput.value));
  });
}
if (roundDurationInput) {
  roundDurationInput.addEventListener("input", () => {
    roundDurationValue.textContent = Math.round(
      Number(roundDurationInput.value)
    );
  });
}

document.getElementById("createRoomConfirm").addEventListener("click", () => {
  const playerName = document.getElementById("playerNameCreate").value.trim();

  if (!playerName) {
    showError("Введите ваше имя");
    return;
  }

  sessionStorage.setItem("playerName", playerName);

  const maxPlayers = maxPlayersInput
    ? Math.round(Number(maxPlayersInput.value))
    : undefined;
  const roundDuration = roundDurationInput
    ? Math.round(Number(roundDurationInput.value))
    : undefined;

  console.log(
    "🎮 Creating room for player:",
    playerName,
    "maxPlayers:",
    maxPlayers,
    "roundDuration:",
    roundDuration
  );
  socket.emit("create-room", {
    playerName,
    sessionId: getOrCreatePlayerSessionId(),
    maxPlayers,
    roundDuration,
  });
});

document.getElementById("joinRoomConfirm").addEventListener("click", () => {
  const password = document
    .getElementById("joinRoomPassword")
    .value.toUpperCase()
    .trim();
  const playerName =
    document.getElementById("playerNameJoin").value.trim() ||
    `Player${Math.floor(Math.random() * 1000)}`;

  if (!password) {
    showError("Введите пароль комнаты");
    return;
  }

  if (password.length !== 4) {
    showError("Пароль должен состоять из 4 символов");
    return;
  }

  sessionStorage.setItem("playerName", playerName);

  console.log(
    "🔗 Joining room with password:",
    password,
    "Player:",
    playerName
  );
  socket.emit("join-room", {
    roomPassword: password,
    playerName,
    sessionId: getOrCreatePlayerSessionId(),
  });
});

document
  .getElementById("playerNameCreate")
  .addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      document.getElementById("createRoomConfirm").click();
    }
  });

document
  .getElementById("joinRoomPassword")
  .addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      document.getElementById("joinRoomConfirm").click();
    }
  });

document.getElementById("playerNameJoin").addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    document.getElementById("joinRoomConfirm").click();
  }
});

socket.on("room-created", (data) => {
  console.log("✅ Room created:", data.roomId, "Password:", data.password);
  console.log("🔗 Redirecting to room:", data.roomId);

  sessionStorage.setItem("lastRoomId", data.roomId);
  sessionStorage.setItem("lastRoomPassword", data.password);
  sessionStorage.setItem("roomCreationTime", Date.now().toString());

  setTimeout(() => {
    window.location.href = `/room/${data.roomId}`;
  }, 200);
});

socket.on("room-joined", (data) => {
  console.log("✅ Joined room:", data.roomId);
  console.log("🔗 Redirecting to room:", data.roomId);

  sessionStorage.setItem("lastRoomId", data.roomId);
  sessionStorage.setItem("roomJoinTime", Date.now().toString());

  setTimeout(() => {
    window.location.href = `/room/${data.roomId}`;
  }, 200);
});

socket.on("error", (message) => {
  console.error("❌ Error:", message);
  showError(message);
});

const ERROR_DISPLAY_MS = 8000;
const ERROR_FADE_MS = 400;

function showError(message) {
  const errorDiv = document.getElementById("errorMessage");

  clearTimeout(errorDiv._hideTimeout);
  clearTimeout(errorDiv._removeTimeout);

  errorDiv.textContent = message;
  errorDiv.classList.remove("hidden");

  void errorDiv.offsetWidth;
  errorDiv.classList.add("show");

  errorDiv._hideTimeout = setTimeout(() => {
    errorDiv.classList.remove("show");
    errorDiv._removeTimeout = setTimeout(() => {
      errorDiv.classList.add("hidden");
    }, ERROR_FADE_MS);
  }, ERROR_DISPLAY_MS);
}
