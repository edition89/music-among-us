const { ROOM_ID_LENGTH } = require("../../config/constants");

const MAX_NAME_LENGTH = 15;
const ROOM_PASSWORD_PATTERN = /^[A-Z0-9]{4}$/;
const ROOM_ID_PATTERN = new RegExp(`^[A-Z0-9]{${ROOM_ID_LENGTH}}$`);
// Постоянный на вкладку идентификатор сессии игрока (main.js/room.js
// генерируют его через crypto.randomUUID(), либо используют текстовый
// фолбэк вида "session-<timestamp>-<random>") — оба формата укладываются
// в 8-64 символа из букв/цифр/дефисов.
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

// Убираем управляющие символы и обрезаем длину имени игрока.
// От XSS клиент защищается экранированием при рендере (см. escapeHtml
// в public/js/room.js), но и на сервере не помешает не хранить
// откровенно "грязные" значения. Символы `<`/`>` намеренно НЕ вырезаем —
// это раньше портило имена вида "<b>Игрок</b>" (превращало их в "bИгрок/b").
function sanitizePlayerName(rawName) {
  if (typeof rawName !== "string") return null;
  const cleaned = rawName
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

function sanitizeSessionId(rawSessionId) {
  if (typeof rawSessionId !== "string") return null;
  const cleaned = rawSessionId.trim().slice(0, 64);
  return SESSION_ID_PATTERN.test(cleaned) ? cleaned : null;
}

function isValidRoomId(roomId) {
  return typeof roomId === "string" && ROOM_ID_PATTERN.test(roomId);
}

function isValidRoomPassword(password) {
  return typeof password === "string" && ROOM_PASSWORD_PATTERN.test(password);
}

module.exports = {
  MAX_NAME_LENGTH,
  sanitizePlayerName,
  sanitizeSessionId,
  isValidRoomId,
  isValidRoomPassword,
};
