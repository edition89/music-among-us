const socket = io();

// Постоянный на вкладку идентификатор сессии игрока. Нужен серверу, чтобы
// при переходе с главной страницы в комнату (новое socket.io-соединение)
// не создавать дубликат игрока, а заменить его старую запись.
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

// Живое обновление подписей у ползунков настроек комнаты
const maxPlayersInput = document.getElementById("maxPlayersInput");
const maxPlayersValue = document.getElementById("maxPlayersValue");
const roundDurationInput = document.getElementById("roundDurationInput");
const roundDurationValue = document.getElementById("roundDurationValue");

if (maxPlayersInput) {
  maxPlayersInput.addEventListener("input", () => {
    maxPlayersValue.textContent = maxPlayersInput.value;
  });
}
if (roundDurationInput) {
  roundDurationInput.addEventListener("input", () => {
    roundDurationValue.textContent = roundDurationInput.value;
  });
}

document.getElementById("createRoomConfirm").addEventListener("click", () => {
  const playerName = document.getElementById("playerNameCreate").value.trim();

  if (!playerName) {
    showError("Введите ваше имя");
    return;
  }

  // Сохраняем имя в sessionStorage
  sessionStorage.setItem("playerName", playerName);

  const maxPlayers = maxPlayersInput ? Number(maxPlayersInput.value) : undefined;
  const roundDuration = roundDurationInput
    ? Number(roundDurationInput.value)
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

  // Сохраняем имя в sessionStorage
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

// Обработка нажатия Enter в формах
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

  // Сохраняем информацию о комнате в sessionStorage
  sessionStorage.setItem("lastRoomId", data.roomId);
  sessionStorage.setItem("lastRoomPassword", data.password);
  sessionStorage.setItem("roomCreationTime", Date.now().toString());

  // Небольшая задержка перед редиректом
  setTimeout(() => {
    window.location.href = `/room/${data.roomId}`;
  }, 200);
});

socket.on("room-joined", (data) => {
  console.log("✅ Joined room:", data.roomId);
  console.log("🔗 Redirecting to room:", data.roomId);

  // Сохраняем информацию о комнате в sessionStorage
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

const ERROR_DISPLAY_MS = 8000; // время показа ошибки
const ERROR_FADE_MS = 400; // должно совпадать с transition в style.css

function showError(message) {
  const errorDiv = document.getElementById("errorMessage");

  // Если предыдущая ошибка ещё показывается/скрывается — сбрасываем её таймеры,
  // чтобы новая ошибка не исчезла раньше времени и анимация не "дёргалась".
  clearTimeout(errorDiv._hideTimeout);
  clearTimeout(errorDiv._removeTimeout);

  errorDiv.textContent = message;
  errorDiv.classList.remove("hidden");

  // Форсируем перерасчёт стилей, чтобы transition сработал даже если
  // блок уже был видим (например, показываем вторую ошибку подряд).
  void errorDiv.offsetWidth;
  errorDiv.classList.add("show");

  errorDiv._hideTimeout = setTimeout(() => {
    errorDiv.classList.remove("show");
    errorDiv._removeTimeout = setTimeout(() => {
      errorDiv.classList.add("hidden");
    }, ERROR_FADE_MS);
  }, ERROR_DISPLAY_MS);
}
