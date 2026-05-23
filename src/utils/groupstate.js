'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STATE_PATH = path.join(DATA_DIR, 'group_state.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// Returns a map of groupUrl → ISO timestamp of when it was last successfully scraped.
// Returns {} if the file doesn't exist yet (first ever run).
function loadGroupState() {
  try {
    ensureDataDir();
    if (!fs.existsSync(STATE_PATH)) return {};
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    console.error(`[groupstate] loadGroupState failed, starting fresh: ${err.message}`);
    return {};
  }
}

function saveGroupState(state) {
  try {
    ensureDataDir();
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[groupstate] saveGroupState failed: ${err.message}`);
  }
}

module.exports = { loadGroupState, saveGroupState };
