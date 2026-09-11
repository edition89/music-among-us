// Простой rate-limiter в памяти: не более `limit` вызовов за `windowMs`
// на один ключ (обычно socket.id). Используется, например, чтобы
// затруднить перебор 4-символьного пароля комнаты через join-room.
function createRateLimiter(limit, windowMs) {
  const hits = new Map(); // key -> timestamps[]

  return {
    isRateLimited(key) {
      const now = Date.now();
      const attempts = (hits.get(key) || []).filter(
        (ts) => now - ts < windowMs
      );
      attempts.push(now);
      hits.set(key, attempts);
      return attempts.length > limit;
    },

    // Вызывать при disconnect, чтобы не копить память по отключившимся сокетам.
    clear(key) {
      hits.delete(key);
    },
  };
}

module.exports = { createRateLimiter };
