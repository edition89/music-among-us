function createRateLimiter(limit, windowMs) {
  const hits = new Map();

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

    clear(key) {
      hits.delete(key);
    },
  };
}

module.exports = { createRateLimiter };
