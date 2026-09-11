// Логика игрового раунда: старт, выбор предателя и музыки, голосование
// и результаты. Все socket.io-события шлёт сам сервис (в отличие от
// roomService, который только меняет состояние комнаты) — сюда часто
// нужно достучаться из таймеров (setTimeout/setInterval), а не только
// в ответ на конкретное событие от клиента.
function createGameService(
  io,
  roomService,
  soundScanner,
  { PREPARE_TIME, ROUND_DURATION }
) {
  function startGame(roomId) {
    const room = roomService.getRoom(roomId);
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
      countdown,
    });

    const countdownInterval = setInterval(() => {
      countdown--;
      if (countdown > 0) {
        io.to(roomId).emit("countdown-update", { countdown });
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

  function endGame(roomId) {
    const room = roomService.getRoom(roomId);
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

    startVoting(roomId);
  }

  function startVoting(roomId) {
    const room = roomService.getRoom(roomId);
    if (!room) return;

    console.log(`🗳️ Starting voting in room: ${roomId}`);

    room.voting = true;
    room.votes = {};

    // Сбрасываем статус голосования у всех игроков
    room.players.forEach((player) => {
      player.hasVoted = false;
      player.votedFor = null;
    });

    io.to(roomId).emit("voting-started", {
      players: roomService.getPublicPlayers(room),
      votedPlayers: roomService.getVotedPlayersSummary(room),
    });

    io.to(roomId).emit("room-info", roomService.getRoomInfo(room));
  }

  function showVotingResults(roomId) {
    const room = roomService.getRoom(roomId);
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
      ? roomService.toPublicPlayer(room.players.get(suspectedImpostorId))
      : null;
    const actualImpostor = room.impostor
      ? roomService.toPublicPlayer(room.players.get(room.impostor))
      : null;

    console.log(
      `🎭 Voting results - Suspected: ${suspectedImpostor?.name}, Actual: ${actualImpostor?.name}, Tie: ${tie}`
    );

    // Завершаем голосование
    room.voting = false;
    room.votes = {};

    io.to(roomId).emit("voting-results", {
      suspectedImpostor,
      actualImpostor,
      votes: room.votes,
      votingResults,
      wasCorrect: !tie && suspectedImpostorId === room.impostor,
      wasTie: tie,
    });

    io.to(roomId).emit("room-info", roomService.getRoomInfo(room));

    // Сбрасываем impostor и статус голосования для следующего раунда
    room.impostor = null;
    room.players.forEach((player) => {
      player.hasVoted = false;
      player.votedFor = null;
    });
  }

  return { startGame, endGame, startVoting, showVotingResults };
}

module.exports = { createGameService };
