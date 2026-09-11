const socket = io();
const roomId = window.location.pathname.split("/").pop();

let currentPlayerId = null;
let isReady = false;
let roomPassword = "";
let players = [];
let myVote = null; // Храним выбор текущего пользователя
let currentVotedPlayers = []; // Храним текущий список проголосовавших

// Получаем имя игрока из sessionStorage
function getPlayerName() {
  return (
    sessionStorage.getItem("playerName") ||
    `Player${Math.floor(Math.random() * 1000)}`
  );
}

console.log("🔗 Loading room:", roomId);

// Получаем информацию о комнате при загрузке
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("roomTitle").textContent = roomId;
  document.getElementById("goHome").addEventListener("click", () => {
    // Убираем confirm и сразу переходим на главную
    window.location.href = "/";
  });

  setupReadyButtons();
  setupVotingButtons();

  // Получаем имя игрока
  const playerName = getPlayerName();
  console.log("👤 Player name:", playerName);

  // Сразу идентифицируемся с комнатой
  console.log("🔍 Immediately identifying with room:", roomId);
  socket.emit("identify-room", { roomId, playerName });

  // Дополнительная идентификация через небольшой промежуток
  const identificationAttempts = [100, 500, 1000, 2000];
  identificationAttempts.forEach((delay) => {
    setTimeout(() => {
      console.log(`🔍 Retry identifying with room (${delay}ms):`, roomId);
      socket.emit("identify-room", { roomId, playerName });
    }, delay);
  });

  // Периодически запрашиваем обновление информации о комнате
  const intervalId = setInterval(() => {
    socket.emit("get-room-info", { roomId });
  }, 3000);

  // Останавливаем интервал при уходе со страницы
  window.addEventListener("beforeunload", () => {
    clearInterval(intervalId);
  });
});

function setupReadyButtons() {
  const readyBtn = document.getElementById("readyBtn");
  const unreadyBtn = document.getElementById("unreadyBtn");

  readyBtn.addEventListener("click", () => {
    console.log("✅ Ready button clicked for room:", roomId);
    socket.emit("player-ready", { roomId });
  });

  unreadyBtn.addEventListener("click", () => {
    console.log("❌ Unready button clicked for room:", roomId);
    socket.emit("player-unready", { roomId });
  });
}

function setupVotingButtons() {
  const nextRoundBtn = document.getElementById("nextRoundBtn");
  nextRoundBtn.addEventListener("click", () => {
    document.getElementById("resultsSection").classList.add("hidden");
    document.getElementById("gameStatus").textContent =
      "Готовьтесь к следующему раунду!";
    updateReadyButtons();
  });
}

// Socket события
socket.on("room-info", (data) => {
  console.log("📊 Room info received:", data);

  if (data.password) {
    roomPassword = data.password;
    document.getElementById("roomPasswordDisplay").textContent = roomPassword;
    console.log("🔑 Room password set to:", roomPassword);
  }

  // Обновляем список игроков
  if (data.players && Array.isArray(data.players)) {
    players = data.players;
    updatePlayersList(data.players);
    document.getElementById("playersCount").textContent = data.players.length;
    document.getElementById("readyCount").textContent = data.readyCount || 0;

    // Используем maxPlayers из данных или значение по умолчанию
    const maxPlayers = data.maxPlayers || 6;
    document.getElementById("maxPlayers").textContent = maxPlayers;

    console.log(
      `👥 Players updated: ${data.players.length} players, ${data.readyCount} ready, max: ${maxPlayers}`
    );

    // Обновляем статус голосования
    if (data.voting) {
      updateVotingStatus(data.players, data.votes);
    }
  }
});

socket.on("voting-updated", (data) => {
  console.log("🗳️ Voting updated:", data);
  updateVotingStatus(data);
});

function createVotingInterface(players) {
  const votingContainer = document.getElementById("votingPlayers");
  const statusContainer = document.getElementById("votingStatus");

  let html = "";
  players.forEach((player) => {
    html += `
            <button class="btn btn-vote" data-player-id="${escapeHtml(player.id)}">
                ${escapeHtml(player.name)}
            </button>
        `;
  });

  votingContainer.innerHTML = html;
  statusContainer.textContent = `Проголосовало: 0/${players.length}`;

  // Сбрасываем состояние голосования
  myVote = null;
  currentVotedPlayers = [];

  // Добавляем обработчики для кнопок голосования
  document.querySelectorAll(".btn-vote").forEach((button) => {
    button.addEventListener("click", (e) => {
      const votedPlayerId = e.target.getAttribute("data-player-id");
      console.log("🗳️ Voting for player:", votedPlayerId);

      // Если уже голосовали за этого игрока - отменяем голос
      if (myVote === votedPlayerId) {
        console.log("🗑️ Cancelling vote");
        cancelVote();
        return;
      }

      // Сохраняем свой выбор
      myVote = votedPlayerId;

      // Сбрасываем выделение со всех кнопок
      document.querySelectorAll(".btn-vote").forEach((btn) => {
        btn.classList.remove("my-vote", "my-vote-confirmed");
      });

      // Выделяем свою кнопку
      e.target.classList.add("my-vote");

      socket.emit("vote-impostor", { roomId, votedPlayerId });
    });
  });
}

function cancelVote() {
  console.log("🗑️ Cancelling vote");
  myVote = null;

  // Сбрасываем выделение со всех кнопок
  document.querySelectorAll(".btn-vote").forEach((btn) => {
    btn.classList.remove("my-vote", "my-vote-confirmed");
    btn.disabled = false;
  });

  // Отправляем серверу информацию об отмене голоса
  socket.emit("cancel-vote", { roomId });
}

socket.on("ready-status-changed", (data) => {
  console.log("🔄 Ready status changed:", data.isReady);
  isReady = data.isReady;

  updateReadyButtons();
});

socket.on("game-starting", (data) => {
  console.log("🎮 Game starting, preparation:", data.prepareTime);
  const gameStatus = document.getElementById("gameStatus");
  gameStatus.textContent = `🎮 Игра начинается через ${data.countdown} секунд...`;
  gameStatus.className = "game-status status-preparing";

  // Скрываем кнопки готовности и секции голосования
  document.getElementById("readyBtn").classList.add("hidden");
  document.getElementById("unreadyBtn").classList.add("hidden");
  document.getElementById("votingSection").classList.add("hidden");
  document.getElementById("resultsSection").classList.add("hidden");
});

socket.on("countdown-update", (data) => {
  console.log("⏱️ Countdown update:", data.countdown);
  const gameStatus = document.getElementById("gameStatus");
  gameStatus.textContent = `🎮 Игра начинается через ${data.countdown} секунд...`;
});

socket.on("voting-started", (data) => {
  console.log("🗳️ Voting started");
  const gameStatus = document.getElementById("gameStatus");
  gameStatus.textContent = "🗳️ Голосование: Кто был предателем?";
  gameStatus.className = "game-status status-voting";

  // Сохраняем игроков
  if (data.players) {
    players = data.players;
  }

  // Показываем секцию голосования
  document.getElementById("votingSection").classList.remove("hidden");
  createVotingInterface(data.players);

  // Обновляем статус голосования
  if (data.votedPlayers) {
    updateVotingStatus({
      votedPlayers: data.votedPlayers,
      totalPlayers: data.players.length,
    });
  }
});

socket.on("vote-cancelled", () => {
  console.log("✅ Vote cancelled on server");
  myVote = null;

  // Сбрасываем выделение
  document.querySelectorAll(".btn-vote").forEach((btn) => {
    btn.classList.remove("my-vote", "my-vote-confirmed");
    btn.disabled = false;
  });
});

socket.on("play-countdown", (data) => {
  console.log("🔊 Playing countdown sound");
  const audio = document.getElementById("gameAudio");

  if (data.sound) {
    audio.src = data.sound;
    audio.loop = false;
    audio.play().catch((e) => console.log("❌ Countdown audio play error:", e));
  }
});

socket.on("play-music", (data) => {
  console.log("🎵 Playing music for:", data.role);
  const gameStatus = document.getElementById("gameStatus");
  const audio = document.getElementById("gameAudio");

  const roleText =
    data.role === "impostor" ? "🎭 ПРЕДАТЕЛЬ" : "👨‍🚀 ЧЛЕН КОМАНДЫ";
  gameStatus.textContent = `🎵 Игра идет! Вы: ${roleText}`;
  gameStatus.className = "game-status status-playing";

  // Воспроизводим музыку
  if (data.sound) {
    audio.src = data.sound;
    audio.loop = true;
    audio.play().catch((e) => console.log("❌ Music audio play error:", e));
  }

  // Таймер обратного отсчета
  let timeLeft = Math.floor(data.duration / 1000);
  updateTimer(gameStatus, roleText, timeLeft);

  const timerInterval = setInterval(() => {
    timeLeft--;
    updateTimer(gameStatus, roleText, timeLeft);

    if (timeLeft <= 0) {
      clearInterval(timerInterval);
    }
  }, 1000);
});

socket.on("play-round-end", (data) => {
  console.log("🔊 Playing round end sound");
  const audio = document.getElementById("gameAudio");

  // Останавливаем текущую музыку
  audio.pause();
  audio.currentTime = 0;

  // Воспроизводим звук завершения
  if (data.sound) {
    audio.src = data.sound;
    audio.loop = false;
    audio.play().catch((e) => console.log("❌ Round end audio play error:", e));
  }
});

socket.on("voting-results", (data) => {
  console.log("📊 Voting results received:", data);
  showVotingResults(data);
});

function updateTimer(gameStatus, roleText, timeLeft) {
  gameStatus.textContent = `🎵 Игра идет! Вы: ${roleText} - Осталось: ${timeLeft}с`;
}

socket.on("error", (message) => {
  console.error("❌ Server error:", message);
  const gameStatus = document.getElementById("gameStatus");

  // Если ошибка "Комната не найдена", пробуем переидентифицироваться
  if (message === "Комната не найдена") {
    const playerName = getPlayerName();
    console.log("🔄 Retrying room identification...");
    setTimeout(() => {
      socket.emit("identify-room", { roomId, playerName });
    }, 500);
  }

  gameStatus.textContent = `❌ Ошибка: ${message}`;
  gameStatus.style.background = "#f44336";
});

socket.on("private-vote-update", (data) => {
  console.log("🔒 Private vote update:", data);

  // Подтверждаем свой выбор
  if (data.votedFor) {
    myVote = data.votedFor;
    const myButton = document.querySelector(
      `.btn-vote[data-player-id="${myVote}"]`
    );
    if (myButton) {
      // Сбрасываем все выделения
      document.querySelectorAll(".btn-vote").forEach((btn) => {
        btn.classList.remove("my-vote", "my-vote-confirmed");
      });
      // Добавляем подтвержденное выделение
      myButton.classList.add("my-vote-confirmed");
    }
  }
});

function updateReadyButtons() {
  const readyBtn = document.getElementById("readyBtn");
  const unreadyBtn = document.getElementById("unreadyBtn");

  if (isReady) {
    readyBtn.classList.add("hidden");
    unreadyBtn.classList.remove("hidden");
  } else {
    readyBtn.classList.remove("hidden");
    unreadyBtn.classList.add("hidden");
  }
}

// Экранирование пользовательского ввода перед вставкой в innerHTML,
// чтобы имя игрока не могло исполнить произвольный HTML/JS (XSS).
function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

function updatePlayersList(players) {
  const container = document.getElementById("playersContainer");

  if (!players || players.length === 0) {
    container.innerHTML =
      '<div class="no-players">Игроки подключаются...</div>';
    return;
  }

  let html = "";

  players.forEach((player) => {
    const statusClass = player.isReady ? "player-ready" : "player-not-ready";
    const statusText = player.isReady ? "✅ Готов" : "⏳ Ожидание";

    html += `
            <div class="player-item">
                <span style="font-weight: bold;">${escapeHtml(player.name)}</span>
                <span class="${statusClass}">${statusText}</span>
            </div>
        `;
  });

  container.innerHTML = html;
}

function updateVotingStatus(data) {
  const statusContainer = document.getElementById("votingStatus");

  // Сохраняем текущие данные
  if (data.votedPlayers) {
    currentVotedPlayers = data.votedPlayers;
  }

  // Исправляем получение количества проголосовавших
  const votedCount = currentVotedPlayers.length;
  const totalCount = data.totalPlayers || players.length;

  console.log(`📊 Voting status: ${votedCount}/${totalCount}`);
  statusContainer.textContent = `Проголосовало: ${votedCount}/${totalCount}`;

  // Добавляем активный класс если есть голоса
  if (votedCount > 0) {
    statusContainer.classList.add("active");
  } else {
    statusContainer.classList.remove("active");
  }
}

function showVotingResults(data) {
  const resultsSection = document.getElementById("resultsSection");
  const resultsContent = document.getElementById("resultsContent");
  const gameStatus = document.getElementById("gameStatus");

  // Скрываем секцию голосования
  document.getElementById("votingSection").classList.add("hidden");

  let resultsHtml = "";

  // Показываем детали голосования
  resultsHtml += '<div class="voting-details">';
  resultsHtml += "<h4>Детали голосования:</h4>";

  if (data.votingResults && players) {
    players.forEach((player) => {
      const voteInfo = data.votingResults[player.id];
      if (voteInfo) {
        const votedPlayer = players.find((p) => p.id === voteInfo.votedFor);
        if (votedPlayer) {
          resultsHtml += `<p><strong>${escapeHtml(voteInfo.voterName)}</strong> → ${escapeHtml(votedPlayer.name)}</p>`;
        }
      }
    });
  }

  resultsHtml += "</div>";

  if (data.wasTie) {
    resultsHtml += `
            <div class="result-tie">
                <h4>🤔 Ничья!</h4>
                <p>Голоса разделились, предателем был <strong>${escapeHtml(data.actualImpostor.name)}</strong></p>
                <p>Никто не был исключен</p>
            </div>
        `;
    gameStatus.textContent = "🤔 Голоса разделились!";
    gameStatus.className = "game-status status-tie";
  } else if (data.wasCorrect) {
    resultsHtml += `
            <div class="result-success">
                <h4>🎉 Правильно!</h4>
                <p>Команда угадала! Предателем действительно был <strong>${escapeHtml(data.actualImpostor.name)}</strong></p>
                <p>Предатель исключен!</p>
            </div>
        `;
    gameStatus.textContent = "🎉 Команда угадала предателя!";
    gameStatus.className = "game-status status-success";
  } else {
    resultsHtml += `
            <div class="result-fail">
                <h4>❌ Неправильно!</h4>
                <p>Команда проголосовала за <strong>${escapeHtml(data.suspectedImpostor.name)}</strong>, но предателем был <strong>${escapeHtml(data.actualImpostor.name)}</strong></p>
                <p>Невиновный исключен!</p>
            </div>
        `;
    gameStatus.textContent = "❌ Команда не угадала предателя!";
    gameStatus.className = "game-status status-fail";
  }

  resultsContent.innerHTML = resultsHtml;
  resultsSection.classList.remove("hidden");

  // Сбрасываем статус готовности
  isReady = false;
}
