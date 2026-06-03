'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

const SESSION_DIR = path.join(__dirname, '..', '..', 'session');
const SESSION_PATH = path.join(SESSION_DIR, 'session.json');

function sessionExists() {
  return fs.existsSync(SESSION_PATH);
}

function getSessionPath() {
  return SESSION_PATH;
}

function ensureSessionDir() {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
}

async function waitForAuthCookies(context, maxWaitMs = 120000) {
  console.log('[auth] Waiting for Facebook auth cookies...');
  console.log('[auth] If a verification prompt appeared in the browser, please complete it now.');

  const deadline = Date.now() + maxWaitMs;
  let lastDot = Date.now();

  while (Date.now() < deadline) {
    const cookies = await context.cookies();
    const hasAuth = cookies.some(c => c.name === 'c_user') && cookies.some(c => c.name === 'xs');
    if (hasAuth) return true;

    if (Date.now() - lastDot > 5000) {
      process.stdout.write('.');
      lastDot = Date.now();
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  process.stdout.write('\n');
  return false;
}

async function saveSession(context, waitForCookies = false) {
  try {
    ensureSessionDir();
    if (waitForCookies) {
      const hasAuth = await waitForAuthCookies(context);
      if (!hasAuth) {
        console.warn('[auth] Auth cookies (c_user/xs) not found — session may not persist login');
      }
    }
    await context.storageState({ path: SESSION_PATH });
    console.log('[auth] Session saved to session/session.json');
  } catch (err) {
    throw new Error(`[auth] saveSession failed: ${err.message}`);
  }
}

async function verifyLogin(page) {
  try {
    await page.goto('https://www.facebook.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    const url = page.url();

    if (url.includes('/checkpoint')) {
      return { loggedIn: false, checkpoint: true };
    }

    // Facebook shows the login form AT facebook.com (URL doesn't change to /login)
    // Reliable check: is the password field visible? If yes → not logged in.
    const loginFormVisible = await page.isVisible('input[name="pass"]').catch(() => false);

    if (loginFormVisible) {
      return { loggedIn: false, checkpoint: false };
    }

    // Secondary: explicit /login redirect
    if (url.includes('/login')) {
      return { loggedIn: false, checkpoint: false };
    }

    return { loggedIn: true, checkpoint: false };
  } catch (err) {
    throw new Error(`[auth] verifyLogin failed: ${err.message}`);
  }
}

async function login(page) {
  try {
    console.log('[auth] Navigating to Facebook...');
    await page.goto('https://www.facebook.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Facebook shows the login form on the homepage when not logged in
    await page.waitForSelector('input[name="email"], #email', { timeout: 15000 });
    await page.fill('input[name="email"], #email', config.fbEmail);

    await page.waitForTimeout(800 + Math.random() * 600);
    await page.fill('input[name="pass"], #pass', config.fbPassword);

    await page.waitForTimeout(500 + Math.random() * 400);
    await page.press('input[name="pass"], #pass', 'Enter');

    // Wait for full page load so auth cookies are set via redirects/XHR
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const url = page.url();

    if (url.includes('/checkpoint')) {
      throw new Error('CHECKPOINT_DETECTED');
    }

    // Confirm login form is gone
    const stillHasLoginForm = await page.isVisible('input[name="pass"]').catch(() => false);

    if (stillHasLoginForm) {
      throw new Error('LOGIN_FAILED — login form still visible after submit (wrong credentials?)');
    }

    console.log('[auth] Login successful');
  } catch (err) {
    throw new Error(`[auth] login failed: ${err.message}`);
  }
}

// Main: load session → verify → re-login if needed → save → return whether re-login was needed
async function ensureLoggedIn(context, page) {
  const hadSession = sessionExists();
  let reloginNeeded = false;

  const { loggedIn, checkpoint } = await verifyLogin(page);

  if (checkpoint) {
    throw new Error('CHECKPOINT_DETECTED — manual intervention required');
  }

  if (!loggedIn) {
    const reason = hadSession ? 'session expired' : 'no session file found';
    console.warn(`[auth] Not logged in (${reason}) — manual re-login required`);
    throw new Error('SESSION_EXPIRED');
  }

  console.log('[auth] Login verified from session — no re-login needed');
  // Profile is persisted automatically by launchPersistentContext — no explicit save needed

  return { reloginNeeded: false, hadSession };
}

module.exports = { ensureLoggedIn, sessionExists, getSessionPath };
