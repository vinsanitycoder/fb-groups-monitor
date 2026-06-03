'use strict';

/**
 * Manual login helper — fully passive.
 * Run once whenever the Facebook session expires.
 *
 * Usage:  node scripts/login.js
 *
 * What it does:
 *   1. Opens a browser window on facebook.com (using the persistent profile)
 *   2. Waits for YOU to log in manually (up to 5 minutes)
 *   3. Profile is saved automatically — no extra step needed
 *   4. Closes and exits — scheduled runs will use the updated profile
 */

require('dotenv').config({ override: true });

const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');

chromium.use(stealth());

// Must match the PROFILE_DIR in src/facebook/browser.js
const PROFILE_DIR = path.join(__dirname, '..', 'profile');
const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes

async function main() {
  console.log('[login] Opening browser...');

  // Use the same persistent profile as the monitor so the session is shared
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
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
  console.log('  The session saves automatically to the profile —');
  console.log('  no extra step needed after you log in.');
  console.log('==================================================');
  console.log('');

  // Poll for the two auth cookies Facebook sets on successful login
  const deadline = Date.now() + MAX_WAIT_MS;
  let loggedIn = false;

  while (Date.now() < deadline) {
    const cookies = await context.cookies();
    const hasAuth = cookies.some(c => c.name === 'c_user') &&
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
    console.error('[login] Not logged in after 5 minutes — profile not updated.');
    await context.close();
    process.exit(1);
  }

  // Profile is persisted automatically by Playwright — no explicit storageState save needed
  console.log('[login] ✓ Session saved to browser profile (profile/)');
  console.log('[login] You can now restart PM2:  pm2 start ecosystem.config.js');
  await context.close();
}

main().catch(err => {
  console.error(`[login] Unexpected error: ${err.message}`);
  process.exit(1);
});
