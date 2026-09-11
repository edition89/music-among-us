const fs = require("fs");
const path = require("path");
const logger = require("./logger");
const { SOUNDS_FOLDER } = require("../config/constants");

class SoundScanner {
  constructor() {
    this.sounds = {
      impostor: [],
      crewmate: [],
      countdown: null,
      roundEnd: null,
    };
    this.scanSounds();
  }

  scanSounds() {
    try {
      const impostorPath = path.join(SOUNDS_FOLDER, "impostor");
      const crewmatePath = path.join(SOUNDS_FOLDER, "crewmate");

      // Сканируем папку предателя
      if (fs.existsSync(impostorPath)) {
        this.sounds.impostor = fs
          .readdirSync(impostorPath)
          .filter((file) => /\.(mp3|wav|ogg)$/i.test(file))
          .map((file) => `/sounds/impostor/${file}`);
      }

      // Сканируем папку команды
      if (fs.existsSync(crewmatePath)) {
        this.sounds.crewmate = fs
          .readdirSync(crewmatePath)
          .filter((file) => /\.(mp3|wav|ogg)$/i.test(file))
          .map((file) => `/sounds/crewmate/${file}`);
      }

      // Сканируем звуки отсчета и завершения
      const countdownPath = path.join(SOUNDS_FOLDER, "countdown.mp3");
      const roundEndPath = path.join(SOUNDS_FOLDER, "round-end.mp3");

      if (fs.existsSync(countdownPath)) {
        this.sounds.countdown = "/sounds/countdown.mp3";
      }

      if (fs.existsSync(roundEndPath)) {
        this.sounds.roundEnd = "/sounds/round-end.mp3";
      }

      logger.debug("🔊 Found sounds:", {
        impostor: this.sounds.impostor.length,
        crewmate: this.sounds.crewmate.length,
        countdown: !!this.sounds.countdown,
        roundEnd: !!this.sounds.roundEnd,
      });
    } catch (error) {
      logger.error("❌ Error scanning sounds:", error);
    }
  }

  getRandomImpostorSound() {
    return this.sounds.impostor.length > 0
      ? this.sounds.impostor[
          Math.floor(Math.random() * this.sounds.impostor.length)
        ]
      : null;
  }

  getRandomCrewmateSound() {
    return this.sounds.crewmate.length > 0
      ? this.sounds.crewmate[
          Math.floor(Math.random() * this.sounds.crewmate.length)
        ]
      : null;
  }

  getCountdownSound() {
    return this.sounds.countdown;
  }

  getRoundEndSound() {
    return this.sounds.roundEnd;
  }

  hasSounds() {
    return this.sounds.impostor.length > 0 && this.sounds.crewmate.length > 0;
  }
}

module.exports = SoundScanner;
