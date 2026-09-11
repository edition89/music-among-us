const socket = io();
const roomId = window.location.pathname.split("/").pop();

let currentPlayerId = null;
let isReady = false;
let roomPassword = "";
let players = [];
let myVote = null;
let currentVotedPlayers = [];

function getPlayerName() {
  return (
    sessionStorage.getItem("playerName") ||
    `Player${Math.floor(Math.random() * 1000)}`
  );
}

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

console.log("🔗 Loading room:", roomId);

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("roomTitle").textContent = roomId;
  document.getElementById("goHome").addEventListener("click", () => {

    window.location.href = "/";
  });

  setupReadyButtons();
  setupVotingButtons();

  const playerName = getPlayerName();
  const sessionId = getOrCreatePlayerSessionId();
  console.log("👤 Player name:", playerName, "session:", sessionId);

  console.log("🔍 Immediately identifying with room:", roomId);
  socket.emit("identify-room", { roomId, playerName, sessionId });

  const identificationAttempts = [100, 500, 1000, 2000];
  identificationAttempts.forEach((delay) => {
    setTimeout(() => {
      console.log(`🔍 Retry identifying with room (${delay}ms):`, roomId);
      socket.emit("identify-room", { roomId, playerName, sessionId });
    }, delay);
  });

  socket.on("connect", () => {
    console.log("🔌 Socket (re)connected, re-identifying with room:", roomId);
    socket.emit("identify-room", { roomId, playerName, sessionId });
  });

  const intervalId = setInterval(() => {
    socket.emit("get-room-info", { roomId });
  }, 3000);

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

socket.on("room-info", (data) => {
  console.log("📊 Room info received:", data);

  if (data.password) {
    roomPassword = data.password;
    document.getElementById("roomPasswordDisplay").textContent = roomPassword;
    console.log("🔑 Room password set to:", roomPassword);
  }

  if (data.players && Array.isArray(data.players)) {
    players = data.players;
    updatePlayersList(data.players);
    document.getElementById("playersCount").textContent = data.players.length;
    document.getElementById("readyCount").textContent = data.readyCount || 0;

    const maxPlayers = data.maxPlayers || 6;
    document.getElementById("maxPlayers").textContent = maxPlayers;

    console.log(
      `👥 Players updated: ${data.players.length} players, ${data.readyCount} ready, max: ${maxPlayers}`
    );

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

  const votablePlayers = players.filter((player) => player.id !== socket.id);

  let html = "";
  votablePlayers.forEach((player) => {
    html += `
            <button class="btn btn-vote" data-player-id="${escapeHtml(player.id)}">
                ${escapeHtml(player.name)}
            </button>
        `;
  });

  votingContainer.innerHTML = html;
  statusContainer.textContent = `Проголосовало: 0/${players.length}`;

  myVote = null;
  currentVotedPlayers = [];

  document.querySelectorAll(".btn-vote").forEach((button) => {
    button.addEventListener("click", (e) => {
      const votedPlayerId = e.target.getAttribute("data-player-id");
      console.log("🗳️ Voting for player:", votedPlayerId);

      if (myVote === votedPlayerId) {
        console.log("🗑️ Cancelling vote");
        cancelVote();
        return;
      }

      myVote = votedPlayerId;

      document.querySelectorAll(".btn-vote").forEach((btn) => {
        btn.classList.remove("my-vote", "my-vote-confirmed");
      });

      e.target.classList.add("my-vote");

      socket.emit("vote-impostor", { roomId, votedPlayerId });
    });
  });
}

function cancelVote() {
  console.log("🗑️ Cancelling vote");
  myVote = null;

  document.querySelectorAll(".btn-vote").forEach((btn) => {
    btn.classList.remove("my-vote", "my-vote-confirmed");
    btn.disabled = false;
  });

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

  if (data.players) {
    players = data.players;
  }

  document.getElementById("votingSection").classList.remove("hidden");
  createVotingInterface(data.players);

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

  if (data.sound) {
    audio.src = data.sound;
    audio.loop = true;
    audio.play().catch((e) => console.log("❌ Music audio play error:", e));
  }

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

  audio.pause();
  audio.currentTime = 0;

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

  if (message === "Комната не найдена") {
    const playerName = getPlayerName();
    const sessionId = getOrCreatePlayerSessionId();
    console.log("🔄 Retrying room identification...");
    setTimeout(() => {
      socket.emit("identify-room", { roomId, playerName, sessionId });
    }, 500);
  }

  gameStatus.textContent = `❌ Ошибка: ${message}`;
  gameStatus.style.background = "#f44336";
});

socket.on("private-vote-update", (data) => {
  console.log("🔒 Private vote update:", data);

  if (data.votedFor) {
    myVote = data.votedFor;
    const myButton = document.querySelector(
      `.btn-vote[data-player-id="${myVote}"]`
    );
    if (myButton) {

      document.querySelectorAll(".btn-vote").forEach((btn) => {
        btn.classList.remove("my-vote", "my-vote-confirmed");
      });

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
    const hostBadge = player.isHost
      ? '<span class="player-host-badge" title="Хост комнаты">👑</span>'
      : "";
    const isDisconnected = player.connected === false;
    const itemClass = isDisconnected
      ? "player-item player-disconnected"
      : "player-item";
    const statusHtml = isDisconnected
      ? '<span class="player-reconnecting">🔌 Переподключение...</span>'
      : `<span class="${statusClass}">${statusText}</span>`;

    html += `
            <div class="${itemClass}">
                <span style="font-weight: bold;">${escapeHtml(player.name)}${hostBadge}</span>
                ${statusHtml}
            </div>
        `;
  });

  container.innerHTML = html;
}

function updateVotingStatus(data) {
  const statusContainer = document.getElementById("votingStatus");

  if (data.votedPlayers) {
    currentVotedPlayers = data.votedPlayers;
  }

  const votedCount = currentVotedPlayers.length;
  const totalCount = data.totalPlayers || players.length;

  console.log(`📊 Voting status: ${votedCount}/${totalCount}`);
  statusContainer.textContent = `Проголосовало: ${votedCount}/${totalCount}`;

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

  document.getElementById("votingSection").classList.add("hidden");

  let resultsHtml = "";

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
            </div>
        `;
    gameStatus.textContent = "🤔 Голоса разделились!";
    gameStatus.className = "game-status status-tie";
  } else if (data.wasCorrect) {
    resultsHtml += `
            <div class="result-success">
                <h4>🎉 Правильно!</h4>
                <p>Команда угадала! Предателем действительно был <strong>${escapeHtml(data.actualImpostor.name)}</strong></p>
            </div>
        `;
    gameStatus.textContent = "🎉 Команда угадала предателя!";
    gameStatus.className = "game-status status-success";
  } else {
    resultsHtml += `
            <div class="result-fail">
                <h4>❌ Неправильно!</h4>
                <p>Команда проголосовала за <strong>${escapeHtml(data.suspectedImpostor.name)}</strong>, но предателем был <strong>${escapeHtml(data.actualImpostor.name)}</strong></p>
            </div>
        `;
    gameStatus.textContent = "❌ Команда не угадала предателя!";
    gameStatus.className = "game-status status-fail";
  }

  resultsContent.innerHTML = resultsHtml;
  resultsSection.classList.remove("hidden");

  isReady = false;
}
