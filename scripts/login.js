'use strict';

/**
 * Manual login helper — fully passive.
 * Run once whenever the Facebook session expires.
 *
 * Usage:  node scripts/login.js
 *
 * What it does:
 *   1. Opens a browser window on facebook.com
 *   2. Waits for YOU to log in manually (up to 5 minutes)
 *   3. Saves the session automatically once login is detected
 *   4. Closes and exits — scheduled runs will use the new session
 */

require('dotenv').config({ override: true });

const fs   = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');

chromium.use(stealth());

const SESSION_PATH = path.join(__dirname, '..', 'session', 'session.json');
const SESSION_DIR  = path.join(__dirname, '..', 'session');
const MAX_WAIT_MS  = 5 * 60 * 1000; // 5 minutes

async function main() {
  console.log('[login] Opening browser...');

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  await page.goto('https://www.facebook.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  console.log('');
  console.log('==================================================');
  console.log('  Browser is open on Facebook.');
  console.log('  Please log in manually in the browser window.');
  console.log('  Complete any verification steps if prompted.');
  console.log('  This script will save the session automatically.');
  console.log('==================================================');
  console.log('');

  // Poll for the two auth cookies Facebook sets on successful login
  const deadline = Date.now() + MAX_WAIT_MS;
  let loggedIn = false;

  while (Date.now() < deadline) {
    const cookies = await context.cookies();
    const hasAuth  = cookies.some(c => c.name === 'c_user') &&
                     cookies.some(c => c.name === 'xs');
    if (hasAuth) {
      loggedIn = true;
      break;
    }
    await new Promise(r => setTimeout(r, 2000));
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  if (!loggedIn) {
    console.error('[login] Not logged in after 5 minutes — session not saved.');
    await browser.close();
    process.exit(1);
  }

  // Save session
  try {
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    await context.storageState({ path: SESSION_PATH });
    console.log('[login] ✓ Session saved to session/session.json');
    console.log('[login] You can now restart PM2:  pm2 start ecosystem.config.js');
  } catch (err) {
    console.error(`[login] Failed to save session: ${err.message}`);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(`[login] Unexpected error: ${err.message}`);
  process.exit(1);
});
