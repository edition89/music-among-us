module.exports = {
  apps: [
    {
      name: "musical-among-us",
      script: "./server.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 3001,
        DOMAIN: "music-among-us.gabibullae.ru", // замените на ваш домен
      },
      error_file: "./logs/err.log",
      out_file: "./logs/out.log",
      log_file: "./logs/combined.log",
      time: true,
      watch: false,
    },
  ],
};
