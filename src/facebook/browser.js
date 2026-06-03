'use strict';

const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');

chromium.use(stealth());

// Persistent browser profile — keeps cookies, localStorage, IndexedDB, and
// fingerprint data between runs so Facebook sees the same "device" every time.
// This dramatically extends session life vs. loading session.json each run.
const PROFILE_DIR = path.join(__dirname, '..', '..', 'profile');

async function launchBrowser(_sessionPath, { headless = true } = {}) {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // Provide a browser-like object for compatibility with index.js (which calls browser.close())
  const browser = { close: () => context.close() };
  return { browser, context, page };
}

module.exports = { launchBrowser };
