'use strict';

module.exports = {
  apps: [
    {
      name: 'fb-monitor',
      script: 'src/index.js',
      // Fire at the top of every hour, Mon–Fri.
      // The script checks "Run Times" in the Google Sheet and exits immediately
      // if it is not a scheduled hour — so only 3 real runs happen per day.
      // Hourly firing also enables the catch-up mechanism: if the Mac was asleep
      // during a scheduled time, the next hourly fire detects the gap and runs.
      cron_restart: '0 * * * 1-5',
      // Discrete runs — do NOT keep the process alive between cron fires
      autorestart: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
