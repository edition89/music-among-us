const logger = require("../../utils/logger");

function createGameService(io, roomService, soundScanner, { PREPARE_TIME }) {
  function startGame(roomId) {
    const room = roomService.getRoom(roomId);
    if (!room) {
      logger.debug(`❌ Cannot start game - room not found: ${roomId}`);
      return;
    }

    logger.debug(`🎮 Starting game in room: ${roomId}`);
    room.status = "preparing";

    const playersArray = Array.from(room.players.values());
    const impostorIndex = Math.floor(Math.random() * playersArray.length);
    const impostor = playersArray[impostorIndex];

    room.impostor = impostor.id;
    impostor.role = "impostor";

    logger.debug(`🎭 Impostor selected: ${impostor.name}`);

    room.currentSounds = {
      impostor: soundScanner.getRandomImpostorSound(),
      crewmate: soundScanner.getRandomCrewmateSound(),
      countdown: soundScanner.getCountdownSound(),
      roundEnd: soundScanner.getRoundEndSound(),
    };

    logger.debug(`🎵 Sounds selected:`, room.currentSounds);

    if (room.currentSounds.countdown) {
      logger.debug(`🔊 Playing countdown sound in room: ${roomId}`);
      io.to(roomId).emit("play-countdown", {
        sound: room.currentSounds.countdown,
        prepareTime: PREPARE_TIME,
      });
    }

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

    setTimeout(() => {
      room.status = "playing";

      logger.debug(`🎵 Playing music in room: ${roomId}`);

      room.players.forEach((player, playerId) => {
        const sound =
          player.role === "impostor"
            ? room.currentSounds.impostor
            : room.currentSounds.crewmate;

        logger.debug(
          `🔊 Sending sound to ${player.name} (${player.role}): ${sound}`
        );

        io.to(playerId).emit("play-music", {
          sound,
          role: player.role,
          duration: room.roundDuration,
        });
      });

      setTimeout(() => {
        endGame(roomId);
      }, room.roundDuration);
    }, PREPARE_TIME);
  }

  function endGame(roomId) {
    const room = roomService.getRoom(roomId);
    if (!room) return;

    logger.debug(`🏁 Ending game in room: ${roomId}`);

    room.status = "waiting";
    room.readyCount = 0;

    room.players.forEach((player) => {
      player.isReady = false;
      player.role = "crewmate";
    });

    if (room.currentSounds && room.currentSounds.roundEnd) {
      logger.debug(`🔊 Playing round end sound in room: ${roomId}`);
      io.to(roomId).emit("play-round-end", {
        sound: room.currentSounds.roundEnd,
      });
    }

    startVoting(roomId);
  }

  function startVoting(roomId) {
    const room = roomService.getRoom(roomId);
    if (!room) return;

    logger.debug(`🗳️ Starting voting in room: ${roomId}`);

    room.voting = true;
    room.votes = {};

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

    logger.debug(`📊 Showing voting results for room: ${roomId}`);

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
      ? roomService.toPublicPlayer(room.players.get(suspectedImpostorId), room)
      : null;
    const actualImpostor = room.impostor
      ? roomService.toPublicPlayer(room.players.get(room.impostor), room)
      : null;

    logger.debug(
      `🎭 Voting results - Suspected: ${suspectedImpostor?.name}, Actual: ${actualImpostor?.name}, Tie: ${tie}`
    );

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

    room.impostor = null;
    room.players.forEach((player) => {
      player.hasVoted = false;
      player.votedFor = null;
    });
  }

  return { startGame, endGame, startVoting, showVotingResults };
}

module.exports = { createGameService };
