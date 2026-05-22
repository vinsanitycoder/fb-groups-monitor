'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const LOCK_PATH = path.join(DATA_DIR, 'run.lock');
const STALE_AGE_MS = 25 * 60 * 1000; // 25 minutes

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// Returns true if lock was acquired, false if another run is active
function acquireLock() {
  ensureDataDir();

  if (fs.existsSync(LOCK_PATH)) {
    const stat = fs.statSync(LOCK_PATH);
    const ageMs = Date.now() - stat.mtimeMs;

    if (ageMs < STALE_AGE_MS) {
      console.warn(`[lock] Another run is active (lock age: ${Math.round(ageMs / 1000)}s). Exiting.`);
      return false;
    }

    console.warn(`[lock] Stale lock found (age: ${Math.round(ageMs / 60000)}m) — removing and continuing`);
    fs.unlinkSync(LOCK_PATH);
  }

  fs.writeFileSync(LOCK_PATH, String(Date.now()));
  return true;
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH);
  } catch (err) {
    console.error(`[lock] releaseLock failed: ${err.message}`);
  }
}

module.exports = { acquireLock, releaseLock };
