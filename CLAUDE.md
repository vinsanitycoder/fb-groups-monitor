# fb_lead_monitor — Agent Guide

---

## ⚠ ALWAYS ACTIVE — Read These Before Anything Else

**These rules apply to every task in this project without exception.**

### 1. Think Before Coding
State assumptions explicitly. If uncertain, ask. If multiple interpretations exist, present them — don't pick silently. If a simpler approach exists, say so. If something is unclear, stop and name what's confusing.

### 2. Simplicity First
Minimum code that solves the problem. No features beyond what was asked, no abstractions for single-use code, no "flexibility" not requested, no error handling for impossible scenarios.

### 3. Surgical Changes
Touch only what you must. Don't improve adjacent code, comments, or formatting. Match existing style. If unrelated dead code is noticed, mention it — don't delete it. Every changed line must trace directly to the request.

### 4. Goal-Driven Execution
Define success criteria before coding. State a plan for multi-step tasks. When in doubt, do less and ask.

---

## What This Project Is
Automated Facebook group monitor. Scrapes Facebook groups for posts matching configured keywords, logs leads to Google Sheets, generates AI draft replies via Claude Haiku, and sends real-time alerts to a Microsoft Teams channel. Operators respond manually from their own Facebook accounts. Runs on a configurable schedule (default 8am–9pm, Mon–Fri) on Mac or Windows.

## User Technical Level
Non-technical operators — no developers on the operations side. Every instruction must include what to click, what to type, what success looks like, and what to do if something looks wrong. The README is written at this level — do not regress it toward developer-speak.

## Rules for Claude (Active Every Session)
- Read this file completely before doing anything each session
- All credentials via environment variables — never hardcoded, never in comments
- When in doubt, do less and ask

## What NOT to Change Without Asking
- `session/` — active Facebook login session; changes break auth
- `data/seen_posts.json` — dedup state; deleting causes re-processing of recent posts
- `data/group_state.json` — per-group last-seen timestamps; deleting causes all posts to re-process on next run
- `src/facebook/auth.js` — login verification logic; changes can break session persistence
- `.env` — credentials file

## Locked Components
- `src/teams/alert.js` (AdaptiveCard structure) — confirmed working 2026-05-20. Do not change card structure without re-testing end-to-end.

## Architecture Decisions — Do Not Reverse Without Discussion
- **Discrete runs only** — script starts, runs, exits. Never a long-running daemon. PM2 restarts on crash, handles scheduling.
- **Local JSON for deduplication** — seen_posts.json on disk. Google Sheets is write-only for leads. Never read Sheets for dedup.
- **Power Automate Workflows only** — Teams Incoming Webhooks retired May 2026. All Teams code uses AdaptiveCard format.
- **Sequential group scraping** — never parallel tabs. More human-like, less detectable by Facebook.
- **Claude Haiku only** — no Sonnet. Prompt caching not implemented (Haiku minimum is 1,024 tokens; our prompt is ~35 tokens — below threshold).
- **Signal phrases currently disabled** — `isRelevant()` accepts signal phrases from the Sheet but does not enforce them (parameter received, not checked). Keyword match alone is the current active filter. Re-enable by adding the signal phrase check back to `relevance.js` when ready. Do not remove the parameter or the Sheet loading — the infrastructure is intentionally kept in place.
- **Five-layer deduplication** — `seen_posts.json` stores post ID, SHA-1 of text, and SHA-1 of URL (cross-run). In-memory per run: URL Set + Jaccard similarity (85% word overlap). `data/group_state.json` stores last-seen timestamp per group; posts older than the previous scrape of that group are filtered before the pipeline. This covers DOM vs GraphQL ID format differences, near-identical text, and repeat alerts across runs.
- **Sheets write uses `RAW` not `USER_ENTERED`** — prevents formula injection when Facebook post text (e.g. `=IMPORTDATA(...)`) is written to the Leads tab. Never revert this.
- **Atomic lock file (`wx` flag)** — `acquireLock()` uses `{ flag: 'wx' }` (O_EXCL) for an atomic exclusive create. Eliminates the TOCTOU race where two processes could both pass an `existsSync` check before either wrote the file.
- **Prompt injection guards in `draft.js`** — post text is scrubbed for instruction-override phrases before reaching Claude; any draft containing an unexpected URL is discarded. Do not remove these guards.
- **`processPost()` is a standalone function** — the full per-post pipeline (filter → dedup → draft → Sheets → Teams → mark-seen) lives in `processPost()` above `main()`, not inline in the group loop. Keep new pipeline steps inside `processPost()`, not in the loop.
- **No module-level side effects in `index.js`** — all guard checks (weekend, hours), flag file reads, and `acquireLock()` run inside `main()`. Do not move them back to module level — doing so breaks the `try/finally` lock guarantee and makes the file untestable.

## Tech Stack
- Runtime: Node.js (current LTS)
- Browser automation: Playwright + playwright-extra (stealth plugin)
- Lead storage: Google Sheets (via googleapis — service account auth)
- AI drafts: Claude Haiku 4.5 (claude-haiku-4-5-20251001)
- Alerts: Microsoft Teams via Power Automate Workflows webhook (NOT Incoming Webhook — deprecated)
- Process management: PM2 (discrete run mode, not daemon)
- Scheduling: PM2 cron on macOS / Task Scheduler on Windows

## Project Structure
- `src/index.js` — main entry point, orchestrates one full run then exits. Contains `processPost()` (the full per-post pipeline) and `main()` (the group loop + lifecycle)
- `src/config.js` — loads + validates all env vars on startup, exits if any missing
- `src/facebook/auth.js` — login, session save/load, login verification
- `src/facebook/scraper.js` — group scraping, post extraction
- `src/facebook/browser.js` — Playwright setup with stealth plugin
- `src/filters/relevance.js` — keyword + signal phrase two-layer matching (free, no Claude)
- `src/sheets/client.js` — Google Sheets API wrapper, batch reads, appends
- `src/claude/draft.js` — Claude Haiku API call, prompt construction, fallback
- `src/teams/alert.js` — Power Automate Workflow webhook, AdaptiveCard format
- `src/utils/dedup.js` — seen_posts.json read/write: post ID, text SHA-1, URL SHA-1, Jaccard similarity
- `src/utils/groupstate.js` — group_state.json read/write: per-group last-seen timestamps
- `src/utils/lock.js` — run lock file (prevents simultaneous instances)
- `src/utils/logger.js` — structured per-run logging
- `session/` — Facebook browser session storage (gitignored, never commit)
- `data/seen_posts.json` — deduplication cache, 7-day rolling window (gitignored)
- `data/group_state.json` — per-group last-seen timestamps (gitignored)
- `data/last_run_at.json` — timestamp of last completed run; used by catch-up mechanism (gitignored)
- `logs/` — per-run logs (gitignored)

## Essential Commands
    node src/index.js                        # run once manually (for testing)
    TEST_MODE=1 node src/index.js            # bypass schedule + weekend checks
    SHOW_BROWSER=1 node src/index.js         # show browser window during run (debugging)
    node scripts/login.js                    # manual Facebook login — run when session expires
    pm2 start ecosystem.config.js            # start with PM2 scheduling
    pm2 delete fb-monitor && pm2 start ecosystem.config.js && pm2 save  # restart + save
    pm2 logs fb-monitor                      # view live logs
    pm2 status                               # check if running

## Code Conventions (Non-Negotiable)
- All credentials via environment variables — never hardcoded, never in comments
- Every async function has explicit try/catch with meaningful error messages
- Each Facebook group scrape is wrapped independently — one group failure must not kill the run
- `config.js` validates ALL required env vars on startup and exits with a named error if any are missing
- `max_tokens: 80` on every Claude API call — hard server-side cap, no exceptions
- Log every run summary to `logs/` with: timestamp, groups checked, posts scraped, posts evaluated (scraped minus old-post skips), leads logged, duration
- **Always use `path.join()` for file paths — never string concatenation** (ensures Windows compatibility)
- Business hours + weekend check runs inside `main()` — not at module level. All guard checks, flag reads, and `acquireLock()` live inside `main()` so `releaseLock()` in `finally` is always paired correctly

## External Integrations (Confirmed Working)
- **Teams (Power Automate Workflows webhook):** Must send full AdaptiveCard JSON with `"type":"AdaptiveCard"` at root. `{"text":"..."}` returns HTTP 202 but silently posts nothing. Confirmed working 2026-05-20.
  - Create: Teams channel → `...` → Workflows → search "webhook" → "Post to a channel when a webhook request is received"
  - **Do NOT use make.powerautomate.com** — HTTP trigger there requires paid Premium licence
  - URL format: `https://default[env].7c.environment.api.powerplatform.com:443/powerautomate/...&sig=...`
  - Test tool: hoppscotch.io — POST, application/json
- **Google Sheets:** Always read Config + Keywords + Groups + Signal Phrases + Disqualifiers + Competitor Signals in ONE `batchGet` call. Never separate calls.
- **Claude Haiku API:** `claude-haiku-4-5-20251001`. See Prompt Caching below.

## Known Issues
- playwright-extra stealth plugin last updated 2023 — may not catch all modern detection signals. Monitor for sudden zero-post runs. (low)
- Power Automate Workflows webhook rate limit unknown — 3-second delay between consecutive Teams posts is in place. (low)
- `maxPostAgeHours` loaded from sheet but not enforced — age filtering not implemented due to inconsistent timestamp formats between DOM and GraphQL sources. (medium)

## Gotchas (Update Every Time Claude Makes a Mistake Here)
- **Teams format** — Adaptive Card only. `{"text":"..."}` returns 202 but posts nothing. Must send full AdaptiveCard JSON with `"type":"AdaptiveCard"` at root. See `teams/alert.js` for the exact working structure.
- **Playwright session bug #36139** — session cookies may not persist. Always verify login AFTER loading session (check for logged-in page element), re-login if verification fails.
- **PM2 persistence** — `pm2 startup` alone is NOT enough. Must also run `pm2 save` after starting the process or it will not survive reboot.
- **Facebook URL formats** — same post can have 3+ different URLs. The dedup system stores a SHA-1 of the cleaned URL (`/groups/name/posts/123456`, query params stripped) in `seen_posts.json`. Always strip query params before storing or comparing URLs.
- **Facebook vanity URL vs numeric group ID** — both can point to the same group. Facebook redirects vanity to numeric. If both are in the Groups sheet, the group is scraped twice. Always use numeric IDs.
- **GraphQL `creation_time` — do NOT use `findDeep(obj, 'creation_time')` on the full Story object.** Nested linked articles have their own `creation_time`; findDeep returns the wrong one (months off, no error). Always search `comet_sections.timestamp` subtree first: `findDeep(obj.comet_sections?.timestamp ?? obj, 'creation_time')`.
- **DOM vs GraphQL post IDs use different formats** — DOM gives numeric IDs; GraphQL gives BASE64 IDs. The same post will never match on ID alone across extraction methods. Mitigated by: (1) scraper merge filters by both ID and URL, (2) cross-run URL SHA-1 dedup in `seen_posts.json` catches re-surfacing posts regardless of which extraction method finds them.
- **Lock file cleanup** — if script is killed mid-run, lock file remains. Startup checks lock age: if older than 25 minutes, treats as stale and deletes it.
- **Claude fallback** — if Claude fails after 2 retries, send Teams alert with "Draft unavailable" message. Never drop a lead because Claude is down. Same fallback fires if a draft is discarded due to prompt injection detection.
- **Formula injection** — `appendLead` uses `valueInputOption: 'RAW'`. Do NOT change this back to `USER_ENTERED`. Facebook post text starting with `=`, `+`, or `-` would execute as a formula in the Leads tab.
- **Prompt injection guards** — `draft.js` strips instruction-override phrases and rejects drafts containing unexpected URLs. Do not remove. The `Claude System Prompt` sheet value is capped at 500 chars in `loadConfig` — values beyond that are truncated with a warning log.
- **Session expired handling** — `ensureLoggedIn` throws `SESSION_EXPIRED` instead of attempting auto-login (Facebook detects and loops the auto-fill). `index.js` catches it and sends a detailed Teams card (`sendSessionExpiredAlert`) with step-by-step re-login instructions for non-technical users. Mid-run expiry is detected when 3+ consecutive groups return `LOGIN_REDIRECT`. Do NOT add auto-login back to `ensureLoggedIn` — use `scripts/login.js` for manual re-login.
- **Catch-up mechanism** — PM2 fires hourly (Mon–Fri). `hasMissedScheduledRun()` compares `data/last_run_at.json` against the configured run times; if the gap exceeds the largest interval between scheduled runs, it runs as a catch-up regardless of the current hour. Scroll depth scales with offline duration: normal=5, >8h=8, >24h=12, >48h=20 passes.
- **Run summary card** — `sendRunSummaryAlert()` fires at the end of every real run (not TEST_MODE, only when `groupsChecked > 0`). Gives the team a visible heartbeat in Teams. Skipped for early exits (wrong run time, no groups, etc.).
- **Mac Energy Saver** — must be set to never sleep on power adapter. If not set, cron runs are silently skipped.

## Prompt Caching
- **Status:** Not implemented — not applicable
- **Reason:** The Claude Haiku system prompt in `src/claude/draft.js` is ~35 tokens — well below the 1,024 token minimum for Haiku. `cache_control` would be silently ignored. Reconsider only if the system prompt grows past 1,024 tokens (e.g. via a long `sheetSystemPrompt`).

## Cross-Platform Notes (Mac + Windows)
- Node.js code is 100% identical on both platforms
- **Mac scheduling**: PM2 cron (`ecosystem.config.js`)
- **Windows scheduling**: Windows Task Scheduler (no PM2 needed — GUI setup, zero extra packages)
- **Mac sleep prevention**: System Settings → Battery → Options → "Prevent automatic sleeping when display is off"
- **Windows sleep prevention**: Power Options → Change plan settings → never sleep
- `ecosystem.config.js` is Mac-only — Windows users ignore it
- Headed browser mode (`headless: false`) works identically on both

## Bot Detection Mitigation (Facebook)
- **Headless by default** — `launchBrowser` defaults to `headless: true` to avoid cluttering the desktop. Pass `{ headless: false }` or set `SHOW_BROWSER=1` env var to make the browser visible for debugging. `scripts/login.js` always opens headed since the user must interact.
- **Randomised delays**: 45–90 seconds between groups (not fixed), 3–7 seconds between scrolls
- **Shuffle group order** each run — never visit in the same sequence
- **Max 15 groups per run** — hard limit regardless of how many are configured
- **Read-only behaviour** — no posting, liking, commenting, following at any time
- **Checkpoint detection** after every group load: CAPTCHA → Teams alert + exit; `/checkpoint/` URL → Teams alert + exit
- **Zero-posts signal**: 3+ consecutive groups returning zero posts → Teams warning + exit (likely detected)
- **playwright-extra stealth plugin** — masks JS-level headless signals (navigator.webdriver etc.)
- **Residential IP** is a significant trust signal — do not run from VPN or datacenter

## Environment Variables Required
See `.env.example` for full list. Validated on startup by `src/config.js`.

```
FB_EMAIL=                         # Facebook monitoring account email
FB_PASSWORD=                      # Facebook monitoring account password
GOOGLE_CREDENTIALS_PATH=./google-credentials.json  # Relative path to service account JSON
GOOGLE_SHEET_ID=                  # Sheet ID from URL (between /d/ and /edit)
TEAMS_WEBHOOK_URL=                # Power Automate Workflows webhook URL (keep secret)
ANTHROPIC_API_KEY=                # Claude API key
```
