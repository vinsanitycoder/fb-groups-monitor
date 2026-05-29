'use strict';

const fs = require('fs');
const path = require('path');

const config = require('./config');
const { launchBrowser } = require('./facebook/browser');
const { ensureLoggedIn, getSessionPath } = require('./facebook/auth');
const { scrapeGroup, scrapeComments } = require('./facebook/scraper');
const { isRelevant } = require('./filters/relevance');
const { loadConfig, appendLead } = require('./sheets/client');
const { generateDraft } = require('./claude/draft');
const { sendLeadAlert, sendSystemAlert, sendSessionExpiredAlert, sendRunSummaryAlert } = require('./teams/alert');
const { loadDedup, isDuplicate, markSeen, markSeenText, isDuplicateText, saveDedup, tokenizePost, isSimilarToSeen, isUrlDuplicate, markUrlSeen } = require('./utils/dedup');
const { acquireLock, releaseLock } = require('./utils/lock');
const { writeRunSummary } = require('./utils/logger');
const { loadGroupState, saveGroupState } = require('./utils/groupstate');

const MAX_GROUPS_PER_RUN = 15;
const ZERO_POSTS_LIMIT = 3;
const LAST_RUN_PATH = path.join(__dirname, '..', 'data', 'last_run_at.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Retry an async function up to `attempts` times with a delay between tries.
// Useful for network calls (Google Sheets, Teams) that fail on transient blips.
async function withRetry(fn, { attempts = 3, delayMs = 5000, label = '' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (i < attempts) {
        console.warn(`[index] ${label} failed (attempt ${i}/${attempts}): ${err.message} — retrying in ${delayMs / 1000}s`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

// Returns true if the Mac was likely asleep or off during a scheduled run time,
// meaning we should run now as a catch-up even though it is not a scheduled hour.
// Logic: if it has been longer than the biggest gap between run times + 30 min,
// at least one scheduled run was missed.
function hasMissedScheduledRun(runTimes, now) {
  try {
    if (!fs.existsSync(LAST_RUN_PATH)) return false;
    const { timestamp } = JSON.parse(fs.readFileSync(LAST_RUN_PATH, 'utf8'));
    const hoursSince = (now - new Date(timestamp)) / (1000 * 60 * 60);
    const sorted = [...runTimes].sort((a, b) => a - b);
    const maxGapHours = sorted.length > 1
      ? Math.max(...sorted.slice(1).map((t, i) => t - sorted[i]))
      : 8; // default: treat as missed if more than 8h since last run
    return hoursSince >= maxGapHours; // trigger as soon as the max gap is exceeded
  } catch {
    return false;
  }
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Convert a post's postedAt field to a Date for last-run comparison.
// Returns null when the timestamp is absent or in an unrecognised format —
// callers treat null as "include this post" to avoid missing real leads.
function parsePostTime(postedAt, runStartMs) {
  if (!postedAt) return null;
  // ISO timestamp from GraphQL — most reliable
  if (/^\d{4}-\d{2}-\d{2}T/.test(postedAt)) {
    const d = new Date(postedAt);
    return isNaN(d.getTime()) ? null : d;
  }
  // DOM relative labels: "36m", "2h", "1d"
  let m;
  if ((m = postedAt.match(/^(\d+)\s*m$/i))) return new Date(runStartMs - parseInt(m[1]) * 60 * 1000);
  if ((m = postedAt.match(/^(\d+)\s*h$/i))) return new Date(runStartMs - parseInt(m[1]) * 60 * 60 * 1000);
  if ((m = postedAt.match(/^(\d+)\s*d$/i))) return new Date(runStartMs - parseInt(m[1]) * 24 * 60 * 60 * 1000);
  // "Monday at 3:00 PM" and similar — too ambiguous to parse safely, include the post
  return null;
}

// Returns true if this post should be processed: either we have no last-seen
// time for this group, or the post's timestamp is after that cutoff.
function isPostNewSinceLastRun(post, lastSeenIso, runStartMs) {
  if (!lastSeenIso) return true;
  const postTime = parsePostTime(post.postedAt, runStartMs);
  if (!postTime) return true; // can't determine age — include to avoid missing leads
  return postTime > new Date(lastSeenIso);
}

// ── Per-post pipeline ─────────────────────────────────────────────────────────
// Runs the full filter → dedup → draft → Sheets → Teams → mark-seen sequence
// for a single post. Returns true if the post became a new lead, false if skipped.
// Extracted from the group loop so each stage is independently readable and testable.
async function processPost(post, {
  dedupCache, alertedUrls, seenPostTokenSets,
  keywords, signalPhrases, disqualifiers, competitorSignals,
  commentAlertThreshold, likeAlertThreshold,
  fbPageUrl, linkProbability, systemPrompt,
  page, summary,
}) {
  if (!post.text) return false;

  // ── 1. Pre-check: keyword OR high activity ──────────────────────────────
  const hasKeyword = keywords.some(k => post.text.toLowerCase().includes(k));
  const isHighActivity = post.commentCount >= commentAlertThreshold || post.likeCount >= likeAlertThreshold;
  if (!hasKeyword && !isHighActivity) {
    console.log(`[index] SKIP (no keyword): ${post.text.slice(0, 60)}`);
    return false;
  }

  // ── 2. Engagement floor — must have ≥3 likes OR ≥3 comments ────────────
  // Bypassed for posts already identified as high-activity (sheet thresholds
  // can be lower than 3, so isHighActivity may already be true).
  if (!isHighActivity && post.likeCount < 3 && post.commentCount < 3) {
    console.log(`[index] SKIP (low engagement — ${post.likeCount} likes, ${post.commentCount} comments): ${post.text.slice(0, 60)}`);
    return false;
  }

  // ── 3. Comment scrape (competitor signal detection) ─────────────────────
  // Also makes the run look more human — navigating to a post before moving on.
  let commentText = '';
  if (competitorSignals.length > 0) {
    commentText = await scrapeComments(page, post.url);
    await wait(randInt(2000, 5000));
  }

  // ── 4. Relevance check ──────────────────────────────────────────────────
  const { pass, reason, competitorSignal, highActivity, commentCount, likeCount } =
    isRelevant(post, keywords, signalPhrases, disqualifiers, competitorSignals, commentText, commentAlertThreshold, likeAlertThreshold);
  if (!pass) {
    console.log(`[index] SKIP (${reason}): ${post.text.slice(0, 60)}`);
    return false;
  }

  // ── 5. Five-layer dedup ─────────────────────────────────────────────────
  if (isDuplicate(post.id, dedupCache))              { console.log(`[index] DEDUP (id): ${post.id}`);                              return false; }
  if (isDuplicateText(post.text, dedupCache))        { console.log(`[index] DEDUP (text sha1): ${post.text.slice(0, 60)}`);       return false; }
  if (post.url && alertedUrls.has(post.url))         { console.log(`[index] DEDUP (url in-run): ${post.url}`);                    return false; }
  if (isUrlDuplicate(post.url, dedupCache))          { console.log(`[index] DEDUP (url cross-run): ${post.url}`);                 return false; }
  if (isSimilarToSeen(post.text, seenPostTokenSets)) { console.log(`[index] DEDUP (jaccard): ${post.text.slice(0, 60)}`);         return false; }

  console.log(`[index] NEW LEAD: ${post.text.slice(0, 80)}`);

  // ── 6. Build lead object ────────────────────────────────────────────────
  const lead = {
    timestamp: new Date().toISOString(),
    groupName: post.groupName,
    postText: post.text.slice(0, 500),
    postUrl: post.url,
    postId: post.id,
    postedAt: post.postedAt || null,
    draftReply: '',
    status: 'New',
    competitorSignal: competitorSignal || false,
    highActivity: highActivity || false,
    commentCount: commentCount || 0,
    likeCount: likeCount || 0,
  };

  // ── 7. Claude draft (before Sheets write so the draft is always saved) ──
  const draft = await generateDraft(post.text, fbPageUrl, linkProbability, systemPrompt);
  if (draft) {
    lead.draftReply = draft;
    console.log(`[index] Draft: "${draft}"`);
  } else {
    lead.draftReply = 'Draft unavailable — Claude API error.';
    console.warn('[index] Claude draft failed — using fallback');
    summary.errors.push('Claude draft failed for post ' + post.id);
  }

  // ── 8. Write to Sheets ──────────────────────────────────────────────────
  try {
    await appendLead(lead);
    console.log(`[index] Written to Sheets: post ${post.id}`);
  } catch (err) {
    console.error(`[index] Sheets write failed: ${err.message}`);
    summary.errors.push(`Sheets write failed: ${err.message}`);
  }

  // ── 9. Teams alert ──────────────────────────────────────────────────────
  try {
    await sendLeadAlert(lead);
    console.log(`[index] Teams alert sent for post ${post.id}`);
  } catch (err) {
    console.error(`[index] Teams alert failed: ${err.message}`);
    summary.errors.push(`Teams alert failed: ${err.message}`);
  }

  // ── 10. Mark seen in all dedup stores ───────────────────────────────────
  markSeen(post.id, dedupCache);
  markSeenText(post.text, dedupCache);
  markUrlSeen(post.url, dedupCache);
  seenPostTokenSets.push(tokenizePost(post.text));
  if (post.url) alertedUrls.add(post.url);

  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // ── Guard checks — fast exits before any I/O or lock acquisition ─────────
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const hour = now.getHours();
  const dayOfWeek = now.getDay(); // 0 = Sunday, 6 = Saturday

  if (process.env.TEST_MODE !== '1') {
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      console.log('[index] Weekend — monitor does not run on Saturdays or Sundays. Exiting.');
      return;
    }
    if (hour < 8 || hour >= 21) {
      console.log(`[index] Outside business hours (${hour}:xx). Exiting.`);
      return;
    }
  } else {
    if (dayOfWeek === 0 || dayOfWeek === 6) console.log(`[index] Weekend (day ${dayOfWeek}) — TEST_MODE override active`);
    if (hour < 8 || hour >= 21) console.log(`[index] Outside business hours (${hour}:xx) — TEST_MODE override active`);
  }

  // ── First-run-of-day detection (for startup Teams alert) ─────────────────
  const startupFlagPath = path.join(__dirname, '..', 'data', `startup_${todayStr}.flag`);
  const isFirstRunToday = !fs.existsSync(startupFlagPath);
  if (isFirstRunToday) {
    try { fs.writeFileSync(startupFlagPath, ''); } catch (_) {}
  }

  // ── Initial catchup detection — deep-scroll on the very first run ever ───
  const catchupFlagPath = path.join(__dirname, '..', 'data', 'initial_catchup.done');
  const isInitialCatchup = !fs.existsSync(catchupFlagPath);
  if (isInitialCatchup) {
    console.log('[index] Initial catchup mode — will scroll deeper to capture last 3 days');
  }

  // ── Lock — acquired here so releaseLock() in finally is always paired ────
  // Previously acquired at module level, which meant a crash between require()
  // and the try block would leave the lock file without ever calling releaseLock().
  if (!acquireLock()) return;

  const startTime = Date.now();
  console.log('[index] Run started');

  const summary = {
    runAt: now.toISOString(),
    groupsChecked: 0,
    postsFound: 0,     // raw count scraped from Facebook
    postsSkippedOld: 0, // filtered out by last-run timestamp (not new since last scrape)
    leadsLogged: 0,
    durationMs: 0,
    errors: [],
  };

  let browser = null;
  let dedupCache = null;
  let groupState = null;

  try {
    // ── 0. Startup alert (first run of the day only) ────────────────────────
    if (isFirstRunToday) {
      await sendSystemAlert(
        'FB Monitor — Started',
        'Scheduler active. Runs 3× per day (Mon–Fri), 8am–9pm.'
      ).catch(err => console.warn('[index] Startup alert failed:', err.message));
    }

    // ── 1. Load config from Sheets ──────────────────────────────────────────
    console.log('[index] Loading config from Google Sheets...');
    const sheetConfig = await withRetry(() => loadConfig(), {
      attempts: 3, delayMs: 8000, label: 'loadConfig',
    });
    const { keywords, groups, signalPhrases, disqualifiers, competitorSignals, fbPageUrl, linkProbability, systemPrompt, monitorEnabled, businessHoursStart, businessHoursEnd, commentAlertThreshold, likeAlertThreshold, runTimes } = sheetConfig;
    console.log(`[index] Config loaded — ${groups.length} group(s), ${keywords.length} keywords`);

    if (!monitorEnabled) {
      console.log('[index] Monitor disabled in Google Sheet. Exiting.');
      return;
    }

    // Sheet-configured business hours (secondary check — top-level check uses
    // hardcoded 8/21 as a fast exit; this enforces the user's sheet values).
    if (process.env.TEST_MODE !== '1' && (hour < businessHoursStart || hour >= businessHoursEnd)) {
      console.log(`[index] Outside sheet-configured business hours (${hour}:xx, sheet: ${businessHoursStart}–${businessHoursEnd}). Exiting.`);
      return;
    }

    // Run times check — only proceed at the configured hours (default: 8, 12, 17),
    // OR when catching up on a missed run (Mac was asleep/off during a scheduled time).
    const isScheduledHour = runTimes.includes(hour);
    const isCatchupRun    = !isScheduledHour && hasMissedScheduledRun(runTimes, now);

    if (process.env.TEST_MODE !== '1' && !isScheduledHour && !isCatchupRun) {
      console.log(`[index] Not a scheduled run time (${hour}:xx, configured: ${runTimes.join(', ')}). Exiting.`);
      return;
    }

    // Calculate how long the Mac was offline so we can tailor the Teams message
    // and use a deeper scroll to recover older posts.
    let hoursSinceLastRun = 0;
    if (isCatchupRun) {
      try {
        const { timestamp } = JSON.parse(fs.readFileSync(LAST_RUN_PATH, 'utf8'));
        hoursSinceLastRun = (now - new Date(timestamp)) / (1000 * 60 * 60);
      } catch (_) {}

      const daysSince    = hoursSinceLastRun / 24;
      const durationText = daysSince >= 2
        ? `approximately ${Math.round(daysSince)} days`
        : daysSince >= 1
          ? 'approximately 1 day'
          : `approximately ${Math.round(hoursSinceLastRun)} hours`;

      const warningLine = hoursSinceLastRun >= 24
        ? ' Posts from the offline period may have been missed — the scan will scroll deeper to recover as many as possible.'
        : '';

      console.log(`[index] Catch-up run — offline for ${durationText}. Running now.`);
      await sendSystemAlert(
        'FB Monitor — Resuming After Offline Period',
        `The monitor was offline for ${durationText} (Mac was off, asleep, or had no internet).${warningLine}`
      ).catch(() => {});
    }

    if (!groups.length) {
      console.warn('[index] No groups configured in Sheets. Exiting.');
      return;
    }

    // ── 2. Load dedup cache + group state ──────────────────────────────────
    dedupCache = loadDedup();
    console.log(`[index] Dedup cache loaded — ${Object.keys(dedupCache).length} known posts`);
    groupState = loadGroupState();
    console.log(`[index] Group state loaded — ${Object.keys(groupState).length} group(s) with last-seen timestamps`);

    // ── 3. Login ────────────────────────────────────────────────────────────
    const sessionPath = getSessionPath();
    const { browser: b, context, page } = await launchBrowser(sessionPath, {
      headless: process.env.SHOW_BROWSER !== '1',
    });
    browser = b;

    try {
      await ensureLoggedIn(context, page);
    } catch (err) {
      if (err.message === 'SESSION_EXPIRED') {
        console.warn('[index] Session expired — alerting via Teams and stopping run');
        await sendSessionExpiredAlert().catch(() => {});
        return;
      }
      throw err;
    }

    // ── 4. Prepare group list — shuffle + cap at 15 (or TEST_GROUPS if set) ──
    const groupLimit = process.env.TEST_GROUPS
      ? parseInt(process.env.TEST_GROUPS, 10)
      : MAX_GROUPS_PER_RUN;
    const targetGroups = shuffle(groups).slice(0, groupLimit);
    console.log(`[index] Scraping ${targetGroups.length} group(s) in random order`);

    let consecutiveZeroPosts = 0;
    let loginRedirectCount = 0;
    // Track URLs alerted this run — prevents the same post firing twice if it
    // somehow survives the scraper merge (e.g. across two groups in one run).
    const alertedUrls = new Set();
    // Token sets for posts alerted this run — used for fuzzy similarity dedup.
    // Catches near-identical posts (same user, multiple groups) where DOM
    // extraction produces slightly different text, defeating the SHA-1 check.
    const seenPostTokenSets = [];

    for (let i = 0; i < targetGroups.length; i++) {
      const groupUrl = targetGroups[i];
      summary.groupsChecked++;

      let posts = [];

      try {
        posts = await scrapeGroup(page, groupUrl, {
          scrollPasses: isInitialCatchup          ? 20  // first ever run — deep scroll
            : hoursSinceLastRun > 48              ? 20  // 2+ days offline
            : hoursSinceLastRun > 24              ? 12  // 1–2 days offline
            : hoursSinceLastRun > 8               ? 8   // missed a few runs
            : 5,                                        // normal run
        });
      } catch (err) {
        if (err.message === 'CHECKPOINT_DETECTED') {
          await sendSystemAlert(
            'FB Monitor — Checkpoint Detected',
            'Facebook checkpoint/CAPTCHA detected. Manual intervention required. Script stopped.'
          ).catch(() => {});
          throw err;
        }
        if (err.message === 'LOGIN_REDIRECT') {
          console.warn(`[index] Login redirect on ${groupUrl} — skipping`);
          summary.errors.push(`Login redirect: ${groupUrl}`);
          loginRedirectCount++;
          // If 3+ groups all redirect to login, the session has expired mid-run
          if (loginRedirectCount >= 3) {
            console.warn('[index] 3+ login redirects — session expired mid-run, alerting and stopping');
            await sendSessionExpiredAlert().catch(() => {});
            return;
          }
          continue;
        }
        if (err.message === 'NOT_JOINED') {
          // Account hasn't joined this group — don't count toward detection limit
          continue;
        }
        console.error(`[index] Scrape error (${groupUrl}): ${err.message}`);
        summary.errors.push(`Scrape error: ${err.message}`);
        continue;
      }

      // ── Zero-posts detection ──────────────────────────────────────────────
      if (posts.length === 0) {
        consecutiveZeroPosts++;
        console.warn(`[index] Zero posts from ${groupUrl} (consecutive: ${consecutiveZeroPosts})`);

        if (consecutiveZeroPosts >= ZERO_POSTS_LIMIT) {
          console.warn('[index] 3+ consecutive zero-post groups — possible detection. Stopping.');
          await sendSystemAlert(
            'FB Monitor — Possible Detection',
            `${ZERO_POSTS_LIMIT} consecutive groups returned 0 posts. Facebook may have detected the bot. Run stopped early.`
          ).catch(() => {});
          break;
        }
      } else {
        consecutiveZeroPosts = 0;
      }

      summary.postsFound += posts.length;

      // ── Last-run filter — skip posts older than the previous scrape ──────
      // Uses raw post count above so zero-posts detection is unaffected.
      // Posts with no parseable timestamp pass through (safe side: never drop a lead).
      if (groupState[groupUrl]) {
        const before = posts.length;
        posts = posts.filter(p => isPostNewSinceLastRun(p, groupState[groupUrl], startTime));
        const skipped = before - posts.length;
        summary.postsSkippedOld += skipped;
        if (skipped > 0) {
          console.log(`[index] Skipped ${skipped} old post(s) — ${posts.length} new to evaluate (last run: ${groupState[groupUrl]})`);
        }
      }

      // ── 5. Filter + dedup + pipeline ──────────────────────────────────────
      for (const post of posts) {
        const wasLead = await processPost(post, {
          dedupCache, alertedUrls, seenPostTokenSets,
          keywords, signalPhrases, disqualifiers, competitorSignals,
          commentAlertThreshold, likeAlertThreshold,
          fbPageUrl, linkProbability, systemPrompt,
          page, summary,
        });
        if (wasLead) {
          summary.leadsLogged++;
          await wait(3000); // rate limit between consecutive Teams posts
        }
      }

      // ── Update this group's last-seen to this run's start time ───────────
      // Only reached on a successful scrape — error paths use continue/throw
      // and never update, so the next run will re-check from the old cutoff.
      groupState[groupUrl] = new Date(startTime).toISOString();

      // ── Delay between groups (45–90s, human-like) ─────────────────────────
      if (i < targetGroups.length - 1) {
        const delayMs = randInt(45000, 90000);
        console.log(`[index] Waiting ${Math.round(delayMs / 1000)}s before next group...`);
        await wait(delayMs);
      }
    }

    // ── 6. Mark initial catchup complete ────────────────────────────────────
    // Skip if TEST_GROUPS is set — partial test runs don't count as a full catchup
    if (isInitialCatchup && !process.env.TEST_GROUPS) {
      try { fs.writeFileSync(catchupFlagPath, new Date().toISOString()); } catch (_) {}
      console.log('[index] Initial catchup complete — future runs will use standard scroll depth');
    }

  } catch (err) {
    console.error(`[index] Fatal error: ${err.message}`);
    summary.errors.push(err.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    // Record when this run happened — used by hasMissedScheduledRun() to detect
    // catch-up situations on the next fire (e.g. Mac waking after sleep).
    try {
      const dataDir = path.join(__dirname, '..', 'data');
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(LAST_RUN_PATH, JSON.stringify({ timestamp: new Date().toISOString() }));
    } catch (_) {}
    // Save dedup cache in finally so it persists even if the run crashes mid-way.
    // Guard against null — dedupCache is null if the crash happened before loadDedup() ran.
    if (dedupCache) {
      saveDedup(dedupCache);
      console.log('[index] Dedup cache saved');
    }
    if (groupState) {
      saveGroupState(groupState);
      console.log('[index] Group state saved');
    }
    releaseLock();
  }

  summary.durationMs = Date.now() - startTime;
  writeRunSummary(summary);

  const evaluated = summary.postsFound - summary.postsSkippedOld;
  console.log(
    `[index] Run complete in ${Math.round(summary.durationMs / 1000)}s — ` +
    `${summary.groupsChecked} group(s), ${summary.postsFound} scraped, ` +
    `${evaluated} evaluated, ${summary.leadsLogged} leads logged`
  );

  // Send a compact status card so the team can see the monitor is alive.
  // Only fires for real runs (groups were actually checked), not early exits.
  // Skipped in TEST_MODE to avoid noise during development.
  if (process.env.TEST_MODE !== '1' && summary.groupsChecked > 0) {
    await sendRunSummaryAlert(summary).catch(err =>
      console.warn('[index] Run summary alert failed:', err.message)
    );
  }
}

main();
