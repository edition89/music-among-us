const {
  ROOM_ID_LENGTH,
  MIN_PLAYERS,
  MAX_PLAYERS_LIMIT,
  DEFAULT_MAX_PLAYERS,
  MIN_ROUND_DURATION,
  MAX_ROUND_DURATION,
  DEFAULT_ROUND_DURATION,
} = require("../../config/constants");

const MAX_NAME_LENGTH = 15;
const ROOM_PASSWORD_PATTERN = /^[A-Z0-9]{4}$/;
const ROOM_ID_PATTERN = new RegExp(`^[A-Z0-9]{${ROOM_ID_LENGTH}}$`);

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

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

function sanitizeMaxPlayers(rawValue) {
  const n = Number(rawValue);
  if (!Number.isFinite(n)) return DEFAULT_MAX_PLAYERS;
  const rounded = Math.round(n);
  return Math.min(MAX_PLAYERS_LIMIT, Math.max(MIN_PLAYERS, rounded));
}

function sanitizeRoundDurationMs(rawSeconds) {
  const n = Number(rawSeconds);
  if (!Number.isFinite(n)) return DEFAULT_ROUND_DURATION;
  const roundedSeconds = Math.round(n);
  const minSeconds = MIN_ROUND_DURATION / 1000;
  const maxSeconds = MAX_ROUND_DURATION / 1000;
  const clampedSeconds = Math.min(
    maxSeconds,
    Math.max(minSeconds, roundedSeconds)
  );
  return clampedSeconds * 1000;
}

module.exports = {
  MAX_NAME_LENGTH,
  sanitizePlayerName,
  sanitizeSessionId,
  isValidRoomId,
  isValidRoomPassword,
  sanitizeMaxPlayers,
  sanitizeRoundDurationMs,
};
