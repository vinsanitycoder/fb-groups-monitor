'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DEDUP_PATH = path.join(DATA_DIR, 'seen_posts.json');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadDedup() {
  try {
    ensureDataDir();
    if (!fs.existsSync(DEDUP_PATH)) return {};

    const raw = fs.readFileSync(DEDUP_PATH, 'utf8');
    const cache = JSON.parse(raw);

    // Prune entries older than 7 days
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const id of Object.keys(cache)) {
      if (cache[id] < cutoff) delete cache[id];
    }
    return cache;
  } catch (err) {
    console.error(`[dedup] loadDedup failed, starting fresh: ${err.message}`);
    return {};
  }
}

function isDuplicate(postId, cache) {
  return Object.prototype.hasOwnProperty.call(cache, postId);
}

function markSeen(postId, cache) {
  cache[postId] = Date.now();
}

// Text fingerprint — normalise + SHA-1 first 500 chars to catch the same post
// shared across multiple Facebook groups (different post IDs, same content).
function _textKey(text) {
  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 500);
  return 'txt_' + crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

function isDuplicateText(text, cache) {
  return Object.prototype.hasOwnProperty.call(cache, _textKey(text));
}

function markSeenText(text, cache) {
  cache[_textKey(text)] = Date.now();
}

function saveDedup(cache) {
  try {
    ensureDataDir();
    // Prune before saving
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const id of Object.keys(cache)) {
      if (cache[id] < cutoff) delete cache[id];
    }
    fs.writeFileSync(DEDUP_PATH, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error(`[dedup] saveDedup failed: ${err.message}`);
  }
}

module.exports = { loadDedup, isDuplicate, markSeen, markSeenText, isDuplicateText, saveDedup };
