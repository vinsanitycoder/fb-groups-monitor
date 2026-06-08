'use strict';

/**
 * Health watchdog — runs every 2 hours via PM2 cron.
 *
 * Checks:
 *   1. Did the monitor crash on its last run? (PM2 exit code)
 *   2. Is the Facebook session still valid? (browser profile check)
 *
 * Sends a Teams alert if either check fails.
 * Skips the session check gracefully if the monitor is actively running
 * (both can't use the same browser profile at the same time).
 */

require('dotenv').config({ override: true });

const fs         = require('fs');
const { exec }   = require('child_process');
const { promisify } = require('util');
const path       = require('path');
const { chromium } = require('playwright-extra');
const stealth    = require('puppeteer-extra-plugin-stealth');

chromium.use(stealth());

const execAsync  = promisify(exec);
const PROFILE_DIR = path.join(__dirname, '..', 'profile');

// Dead-man's switch: alert if no successful scrape in too long during business
// hours, regardless of cause. Written by index.js on every successful run.
const LAST_SUCCESS_PATH   = path.join(__dirname, '..', 'data', 'last_success_at.json');
const STALE_ALERT_PATH    = path.join(__dirname, '..', 'data', 'staleness_alerted.json');
const STALE_THRESHOLD_HRS = 6;   // no success in this long during business hours = problem
const STALE_ALERT_EVERY_HRS = 6; // re-alert at most this often, so an outage is not spammy

const { sendSystemAlert, sendSessionExpiredAlert } = require('../src/teams/alert');

// Returns hours since the last successful run, or Infinity if none recorded.
function hoursSinceLastSuccess(now) {
  try {
    const { at } = JSON.parse(fs.readFileSync(LAST_SUCCESS_PATH, 'utf8'));
    return (now - new Date(at)) / (1000 * 60 * 60);
  } catch {
    return Infinity;
  }
}

// Throttle the staleness alert so a sustained outage sends it at most every
// STALE_ALERT_EVERY_HRS, not on every 2-hourly watchdog fire.
function staleAlertThrottled(now) {
  try {
    const { at } = JSON.parse(fs.readFileSync(STALE_ALERT_PATH, 'utf8'));
    return (now - new Date(at)) / (1000 * 60 * 60) < STALE_ALERT_EVERY_HRS;
  } catch {
    return false;
  }
}

function markStaleAlerted(now) {
  try { fs.writeFileSync(STALE_ALERT_PATH, JSON.stringify({ at: now.toISOString() })); } catch (_) {}
}

// ── PM2 status check ─────────────────────────────────────────────────────────

async function getMonitorStatus() {
  try {
    const { stdout } = await execAsync('pm2 jlist');
    const processes  = JSON.parse(stdout);
    const monitor    = processes.find(p => p.name === 'fb-monitor');
    if (!monitor) return { found: false };
    return {
      found:     true,
      status:    monitor.pm2_env.status,       // 'online' | 'stopped' | 'errored'
      exitCode:  monitor.pm2_env.exit_code,    // 0 = clean, non-zero = crash
      restarts:  monitor.pm2_env.restart_time,
    };
  } catch (err) {
    return { found: false, error: err.message };
  }
}

// ── Facebook session check ────────────────────────────────────────────────────
// Returns: true (logged in) | false (expired) | null (skipped — profile in use)

async function checkFacebookSession() {
  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
      viewport:  { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    const url = page.url();
    if (url.includes('/login') || url.includes('/checkpoint')) return false;

    const loginFormVisible = await page.isVisible('input[name="pass"]').catch(() => false);
    return !loginFormVisible;

  } catch (err) {
    // Profile locked = monitor is actively scraping right now = session is fine
    const profileLocked =
      err.message.includes('user data directory is already in use') ||
      err.message.includes('SingletonLock') ||
      err.message.includes('lock');

    if (profileLocked) {
      console.log('[watchdog] Browser profile in use — monitor is running, skipping session check');
      return null;
    }

    console.warn(`[watchdog] Session check error: ${err.message}`);
    return null;

  } finally {
    if (context) await context.close().catch(() => {});
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[watchdog] Running health check...');

  // ── Check 1: did the monitor crash on its last run? ───────────────────────
  const pm2 = await getMonitorStatus();
  console.log(`[watchdog] PM2: found=${pm2.found} status=${pm2.status} exit_code=${pm2.exitCode} restarts=${pm2.restarts}`);

  const crashed =
    pm2.found && (
      pm2.status === 'errored' ||
      (pm2.status === 'stopped' && pm2.exitCode != null && pm2.exitCode !== 0)
    );

  if (!pm2.found) {
    await sendSystemAlert(
      '🛑 FB Monitor — Process Missing',
      'The fb-monitor process was not found in PM2. It may have been deleted.\n\nTo restart it, open Terminal and run:\n\npm2 delete fb-monitor && pm2 start ecosystem.config.js && pm2 save'
    ).catch(err => console.error(`[watchdog] Alert failed: ${err.message}`));
    return;
  }

  if (crashed) {
    console.warn(`[watchdog] Monitor crashed (exit_code: ${pm2.exitCode}) — checking session...`);

    // Only check session when monitor is not running (avoids profile conflict)
    const sessionValid = await checkFacebookSession();

    if (sessionValid === false) {
      console.warn('[watchdog] Session expired — sending re-login alert');
      await sendSessionExpiredAlert()
        .catch(err => console.error(`[watchdog] Alert failed: ${err.message}`));
    } else {
      await sendSystemAlert(
        '🛑 FB Monitor Crashed',
        `The monitor exited with an error (exit code: ${pm2.exitCode}).\n\nFacebook session appears valid — this was likely a different crash.\n\nCheck logs:\npm2 logs fb-monitor --lines 50\n\nThen restart:\npm2 delete fb-monitor && pm2 start ecosystem.config.js && pm2 save`
      ).catch(err => console.error(`[watchdog] Alert failed: ${err.message}`));
    }
    return;
  }

  // ── Check 2: proactive session check (monitor not crashed) ────────────────
  console.log('[watchdog] PM2 status OK — checking Facebook session...');
  const sessionValid = await checkFacebookSession();

  if (sessionValid === false) {
    console.warn('[watchdog] Session expired (proactive) — sending alert');
    await sendSessionExpiredAlert()
      .catch(err => console.error(`[watchdog] Alert failed: ${err.message}`));
  } else if (sessionValid === null) {
    console.log('[watchdog] Session check skipped (monitor running or check failed)');
  } else {
    console.log('[watchdog] Session valid ✓');
  }

  // ── Check 3: dead-man's switch — has a successful run happened recently? ───
  // Catches ANY silent failure (network outage, FB block, bug) by watching for
  // the absence of success, not a specific failure type. Only during weekday
  // business hours so it does not fire overnight or before the day's first run.
  const now = new Date();
  const weekday = now.getDay() >= 1 && now.getDay() <= 5;
  const hour = now.getHours();
  const inBusinessHours = hour >= 11 && hour <= 21; // after the first run+watchdog cycle
  const staleHrs = hoursSinceLastSuccess(now);

  if (weekday && inBusinessHours && staleHrs > STALE_THRESHOLD_HRS) {
    if (staleAlertThrottled(now)) {
      console.log(`[watchdog] No success in ${staleHrs === Infinity ? 'a long time' : staleHrs.toFixed(1) + 'h'} — alert already sent recently, suppressing`);
    } else {
      console.warn(`[watchdog] No successful run in ${staleHrs === Infinity ? 'a long time' : staleHrs.toFixed(1) + 'h'} during business hours — sending alert`);
      const howLong = staleHrs === Infinity ? 'a long time' : `about ${Math.round(staleHrs)} hours`;
      await sendSystemAlert(
        '🛑 FB Monitor — No Successful Runs',
        `The monitor has not completed a successful run in ${howLong}, even though it should run during business hours.\n\n` +
        `Likely causes: the computer lost internet, went to sleep, or Facebook is blocking it. The monitor keeps trying automatically, but leads may be getting missed right now.\n\n` +
        `Please check that the computer is on, awake, and connected to the internet. If it looks fine, double-click "FB Monitor Login" on the Desktop to refresh the session.`
      ).catch(err => console.error(`[watchdog] Alert failed: ${err.message}`));
      markStaleAlerted(now);
    }
  } else {
    console.log(`[watchdog] Last success ${staleHrs === Infinity ? 'unknown' : staleHrs.toFixed(1) + 'h ago'} (weekday=${weekday}, businessHours=${inBusinessHours}) — OK`);
  }

  console.log('[watchdog] Health check complete');
}

main().catch(err => {
  console.error(`[watchdog] Unexpected error: ${err.message}`);
  process.exit(0); // Always exit cleanly so PM2 doesn't count this as a crash
});
