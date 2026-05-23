'use strict';

module.exports = {
  apps: [
    {
      name: 'fb-monitor',
      script: 'src/index.js',
      // Fire at the top of every hour, Mon–Fri.
      // The script checks the sheet's "Run Times" config and exits immediately
      // if the current hour is not a scheduled run time — so changing the schedule
      // only requires editing the Google Sheet, not this file.
      cron_restart: '0 * * * 1-5',
      // Discrete runs — do NOT keep the process alive between cron fires
      autorestart: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
