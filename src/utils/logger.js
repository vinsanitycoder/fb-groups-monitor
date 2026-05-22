'use strict';

const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', '..', 'logs');

function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function writeRunSummary(summary) {
  try {
    ensureLogsDir();

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.join(LOGS_DIR, `run-${ts}.json`);
    fs.writeFileSync(filename, JSON.stringify(summary, null, 2));
    console.log(`[logger] Run summary written to logs/run-${ts}.json`);
  } catch (err) {
    console.error(`[logger] Failed to write run summary: ${err.message}`);
  }
}

module.exports = { writeRunSummary };
