const socket = io();

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

document.getElementById("createRoomConfirm").addEventListener("click", () => {
  const playerName = document.getElementById("playerNameCreate").value.trim();

  if (!playerName) {
    showError("Введите ваше имя");
    return;
  }

  // Сохраняем имя в sessionStorage
  sessionStorage.setItem("playerName", playerName);

  console.log("🎮 Creating room for player:", playerName);
  socket.emit("create-room", { playerName });
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
  socket.emit("join-room", { roomPassword: password, playerName });
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

function showError(message) {
  const errorDiv = document.getElementById("errorMessage");
  errorDiv.textContent = message;
  errorDiv.classList.remove("hidden");

  setTimeout(() => {
    errorDiv.classList.add("hidden");
  }, 5000);
}
