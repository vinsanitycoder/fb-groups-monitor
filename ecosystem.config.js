'use strict';

module.exports = {
  apps: [
    {
      name: 'fb-monitor',
      script: 'src/index.js',
      // Fire at :00 and :30 for every hour from 8am to 8:30pm
      cron_restart: '*/30 8-20 * * *',
      // Discrete runs — do NOT keep the process alive between cron fires
      autorestart: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
