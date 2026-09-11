const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const isProduction = process.env.NODE_ENV === "production";
const minLevel = isProduction ? LEVELS.warn : LEVELS.debug;

function write(level, args) {
  if (LEVELS[level] < minLevel) return;
  const method = level === "debug" ? "log" : level;
  console[method](...args);
}

module.exports = {
  debug: (...args) => write("debug", args),
  info: (...args) => write("info", args),
  warn: (...args) => write("warn", args),
  error: (...args) => write("error", args),
};
