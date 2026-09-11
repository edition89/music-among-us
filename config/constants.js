module.exports = {
  // Значение по умолчанию и границы для настроек комнаты, которые хост
  // задаёт при создании (см. server/schemas/validation.js — там значения
  // от клиента приводятся к этим границам).
  DEFAULT_MAX_PLAYERS: 6,
  MIN_PLAYERS: 3,
  MAX_PLAYERS_LIMIT: 10,

  DEFAULT_ROUND_DURATION: 30000, // 30 секунд, в мс
  MIN_ROUND_DURATION: 10000, // 10 секунд, в мс
  MAX_ROUND_DURATION: 30000, // 30 секунд, в мс

  PREPARE_TIME: 3000, // 3 seconds
  ROOM_ID_LENGTH: 6,
  SOUNDS_FOLDER: "./public/sounds",
};
