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

// Returns true if lock was acquired, false if another run is active.
// Uses O_EXCL (flag: 'wx') for an atomic create — eliminates the TOCTOU race
// between existsSync and writeFileSync that allowed two processes to both pass
// the check before either completed the write.
function acquireLock() {
  ensureDataDir();

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      fs.writeFileSync(LOCK_PATH, String(Date.now()), { flag: 'wx' });
      return true; // atomic create succeeded — lock is ours
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // Lock file already exists — check whether it is stale
      try {
        const stat = fs.statSync(LOCK_PATH);
        const ageMs = Date.now() - stat.mtimeMs;

        if (ageMs < STALE_AGE_MS) {
          console.warn(`[lock] Another run is active (lock age: ${Math.round(ageMs / 1000)}s). Exiting.`);
          return false;
        }

        console.warn(`[lock] Stale lock found (age: ${Math.round(ageMs / 60000)}m) — removing and retrying`);
        fs.unlinkSync(LOCK_PATH);
        // Loop back and retry the atomic write
      } catch (statErr) {
        if (statErr.code === 'ENOENT') continue; // deleted between write attempt and stat — retry
        throw statErr;
      }
    }
  }

  console.warn('[lock] Could not acquire lock after 2 attempts. Exiting.');
  return false;
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH);
  } catch (err) {
    console.error(`[lock] releaseLock failed: ${err.message}`);
  }
}

module.exports = { acquireLock, releaseLock };
