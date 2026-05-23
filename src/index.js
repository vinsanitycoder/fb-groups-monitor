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
const { sendLeadAlert, sendSystemAlert, sendSessionExpiredAlert } = require('./teams/alert');
const { loadDedup, isDuplicate, markSeen, markSeenText, isDuplicateText, saveDedup, tokenizePost, isSimilarToSeen, isUrlDuplicate, markUrlSeen } = require('./utils/dedup');
const { acquireLock, releaseLock } = require('./utils/lock');
const { writeRunSummary } = require('./utils/logger');

const MAX_GROUPS_PER_RUN = 15;
const ZERO_POSTS_LIMIT = 3;

// ── Business hours + weekend check ───────────────────────────────────────────
const now = new Date();
const todayStr = now.toISOString().slice(0, 10);
const hour = now.getHours();
const dayOfWeek = now.getDay(); // 0 = Sunday, 6 = Saturday

const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
if (isWeekend) {
  if (process.env.TEST_MODE === '1') {
    console.log(`[index] Weekend (day ${dayOfWeek}) — TEST_MODE override active`);
  } else {
    console.log(`[index] Weekend — monitor does not run on Saturdays or Sundays. Exiting.`);
    process.exit(0);
  }
}

if (hour < 8 || hour >= 21) {
  if (process.env.TEST_MODE === '1') {
    console.log(`[index] Outside business hours (${hour}:xx) — TEST_MODE override active`);
  } else {
    console.log(`[index] Outside business hours (${hour}:xx). Exiting.`);
    process.exit(0);
  }
}

// ── First-run-of-day detection (for startup Teams alert) ─────────────────────
const startupFlagPath = path.join(__dirname, '..', 'data', `startup_${todayStr}.flag`);
const isFirstRunToday = !fs.existsSync(startupFlagPath);
if (isFirstRunToday) {
  try { fs.writeFileSync(startupFlagPath, ''); } catch (_) {}
}

// ── Initial catchup detection — deep-scroll on the very first run ever ────────
const catchupFlagPath = path.join(__dirname, '..', 'data', 'initial_catchup.done');
const isInitialCatchup = !fs.existsSync(catchupFlagPath);
if (isInitialCatchup) {
  console.log('[index] Initial catchup mode — will scroll deeper to capture last 3 days');
}

// ── Lock check — exit immediately if another run is active ────────────────────
if (!acquireLock()) {
  process.exit(0);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
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

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();
  console.log('[index] Run started');

  const summary = {
    runAt: now.toISOString(),
    groupsChecked: 0,
    postsFound: 0,
    leadsLogged: 0,
    durationMs: 0,
    errors: [],
  };

  let browser = null;
  let dedupCache = null;

  try {
    // ── 0. Startup alert (first run of the day only) ────────────────────────
    if (isFirstRunToday) {
      await sendSystemAlert(
        'FB Monitor — Started',
        'Scheduler active. Running every 30 min, 8am–9pm.'
      ).catch(err => console.warn('[index] Startup alert failed:', err.message));
    }

    // ── 1. Load config from Sheets ──────────────────────────────────────────
    console.log('[index] Loading config from Google Sheets...');
    const sheetConfig = await loadConfig();
    const { keywords, groups, signalPhrases, disqualifiers, competitorSignals, fbPageUrl, linkProbability, systemPrompt, monitorEnabled, businessHoursStart, businessHoursEnd, commentAlertThreshold, likeAlertThreshold } = sheetConfig;
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

    if (!groups.length) {
      console.warn('[index] No groups configured in Sheets. Exiting.');
      return;
    }

    // ── 2. Load dedup cache ─────────────────────────────────────────────────
    dedupCache = loadDedup();
    console.log(`[index] Dedup cache loaded — ${Object.keys(dedupCache).length} known posts`);

    // ── 3. Login ────────────────────────────────────────────────────────────
    const sessionPath = getSessionPath();
    const { browser: b, context, page } = await launchBrowser(sessionPath);
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
          scrollPasses: isInitialCatchup ? 20 : 5,
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

      // ── 5. Filter + dedup + pipeline ──────────────────────────────────────
      for (const post of posts) {
        if (!post.text) continue;

        // Pre-check: skip comment scraping if no keyword AND not high activity
        const hasKeyword = keywords.some(k => post.text.toLowerCase().includes(k));
        const isHighActivity = post.commentCount >= commentAlertThreshold || post.likeCount >= likeAlertThreshold;
        if (!hasKeyword && !isHighActivity) {
          console.log(`[index] SKIP (no keyword): ${post.text.slice(0, 60)}`);
          continue;
        }

        // Engagement filter — must have ≥3 likes OR ≥3 comments.
        // Skip this check for posts already identified as high-activity
        // (isHighActivity uses the sheet-configured thresholds which can be < 3).
        if (!isHighActivity && post.likeCount < 3 && post.commentCount < 3) {
          console.log(`[index] SKIP (low engagement — ${post.likeCount} likes, ${post.commentCount} comments): ${post.text.slice(0, 60)}`);
          continue;
        }

        // For keyword-matched posts, navigate to the post and read comments.
        // Detects competitor activity in comments AND makes the run look more human.
        let commentText = '';
        if (competitorSignals.length > 0) {
          commentText = await scrapeComments(page, post.url);
          await wait(randInt(2000, 5000));
        }

        const { pass, reason, competitorSignal, highActivity, commentCount, likeCount } = isRelevant(post, keywords, signalPhrases, disqualifiers, competitorSignals, commentText, commentAlertThreshold, likeAlertThreshold);
        if (!pass) {
          console.log(`[index] SKIP (${reason}): ${post.text.slice(0, 60)}`);
          continue;
        }

        if (isDuplicate(post.id, dedupCache)) {
          console.log(`[index] DEDUP: post ${post.id} already seen`);
          continue;
        }

        if (isDuplicateText(post.text, dedupCache)) {
          console.log(`[index] DEDUP (cross-group duplicate): ${post.text.slice(0, 60)}`);
          continue;
        }

        if (post.url && alertedUrls.has(post.url)) {
          console.log(`[index] DEDUP (same URL already alerted this run): ${post.url}`);
          continue;
        }

        if (isUrlDuplicate(post.url, dedupCache)) {
          console.log(`[index] DEDUP (URL seen in a previous run): ${post.url}`);
          continue;
        }

        if (isSimilarToSeen(post.text, seenPostTokenSets)) {
          console.log(`[index] DEDUP (similar text — likely same post in multiple groups): ${post.text.slice(0, 60)}`);
          continue;
        }

        console.log(`[index] NEW LEAD: ${post.text.slice(0, 80)}`);

        const timestamp = new Date().toISOString();
        const lead = {
          timestamp,
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

        // ── Claude draft (before Sheets write so the draft is saved) ─────
        const draft = await generateDraft(post.text, fbPageUrl, linkProbability, systemPrompt);
        if (draft) {
          lead.draftReply = draft;
          console.log(`[index] Draft: "${draft}"`);
        } else {
          lead.draftReply = 'Draft unavailable — Claude API error.';
          console.warn('[index] Claude draft failed — using fallback');
          summary.errors.push('Claude draft failed for post ' + post.id);
        }

        // ── Write to Sheets ──────────────────────────────────────────────
        try {
          await appendLead(lead);
          console.log(`[index] Written to Sheets: post ${post.id}`);
        } catch (err) {
          console.error(`[index] Sheets write failed: ${err.message}`);
          summary.errors.push(`Sheets write failed: ${err.message}`);
        }

        // ── Teams alert ──────────────────────────────────────────────────
        try {
          await sendLeadAlert(lead);
          console.log(`[index] Teams alert sent for post ${post.id}`);
        } catch (err) {
          console.error(`[index] Teams alert failed: ${err.message}`);
          summary.errors.push(`Teams alert failed: ${err.message}`);
        }

        // ── Mark seen ────────────────────────────────────────────────────
        markSeen(post.id, dedupCache);
        markSeenText(post.text, dedupCache);
        markUrlSeen(post.url, dedupCache);
        seenPostTokenSets.push(tokenizePost(post.text));
        if (post.url) alertedUrls.add(post.url);
        summary.leadsLogged++;

        // 3-second rate limit between consecutive Teams posts
        if (summary.leadsLogged >= 1) {
          await wait(3000);
        }
      }

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
    // Save dedup cache in finally so it persists even if the run crashes mid-way.
    // Guard against null — dedupCache is null if the crash happened before loadDedup() ran.
    if (dedupCache) {
      saveDedup(dedupCache);
      console.log('[index] Dedup cache saved');
    }
    releaseLock();
  }

  summary.durationMs = Date.now() - startTime;
  writeRunSummary(summary);
  console.log(
    `[index] Run complete in ${Math.round(summary.durationMs / 1000)}s — ` +
    `${summary.groupsChecked} group(s), ${summary.postsFound} posts found, ` +
    `${summary.leadsLogged} leads logged`
  );
}

main();
