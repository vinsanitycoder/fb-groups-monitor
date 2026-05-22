# fb_lead_monitor — Agent Guide

## What This Project Is
Automated Facebook group monitor. Scrapes Facebook groups for posts matching configured keywords,
logs leads to Google Sheets, generates AI draft replies via Claude Haiku, and sends real-time
alerts to a Microsoft Teams channel. Operators respond manually from their own Facebook accounts.
Runs on a configurable schedule (default 8am–9pm) on Mac or Windows.

## Tech Stack
- Runtime: Node.js (current LTS)
- Browser automation: Playwright + playwright-extra (stealth plugin)
- Lead storage: Google Sheets (via googleapis — service account auth)
- AI drafts: Claude Haiku 4.5 (claude-haiku-4-5-20251001)
- Alerts: Microsoft Teams via Power Automate Workflows webhook (NOT Incoming Webhook — deprecated)
- Process management: PM2 (discrete run mode, not daemon)
- Scheduling: PM2 cron on macOS

## Project Structure
- `src/index.js` — main entry point, orchestrates one full run then exits
- `src/config.js` — loads + validates all env vars on startup, exits if any missing
- `src/facebook/auth.js` — login, session save/load, login verification
- `src/facebook/scraper.js` — group scraping, post extraction
- `src/facebook/browser.js` — Playwright setup with stealth plugin
- `src/filters/relevance.js` — keyword + signal phrase two-layer matching (free, no Claude)
- `src/sheets/client.js` — Google Sheets API wrapper, batch reads, appends
- `src/claude/draft.js` — Claude Haiku API call, prompt construction, fallback
- `src/teams/alert.js` — Power Automate Workflow webhook, AdaptiveCard format
- `src/utils/dedup.js` — local seen_posts.json read/write (NOT Sheets reads for dedup)
- `src/utils/lock.js` — run lock file (prevents simultaneous instances)
- `src/utils/logger.js` — structured per-run logging
- `session/` — Facebook browser session storage (gitignored, never commit)
- `data/seen_posts.json` — deduplication cache, 7-day rolling window (gitignored)
- `logs/` — per-run logs (gitignored)

## Essential Commands
    node src/index.js        # run once manually (for testing)
    pm2 start ecosystem.config.js  # start with PM2 scheduling
    pm2 logs fb-monitor      # view live logs
    pm2 status               # check if running

## Architecture Decisions — Do Not Reverse Without Discussion
- **Discrete runs only** — script starts, runs, exits. Never a long-running daemon. PM2 restarts on crash, handles scheduling.
- **Local JSON for deduplication** — seen_posts.json on disk. Google Sheets is write-only for leads. Never read Sheets for dedup.
- **Power Automate Workflows only** — Teams Incoming Webhooks retired May 2026. All Teams code uses AdaptiveCard format.
- **Sequential group scraping** — never parallel tabs. More human-like, less detectable by Facebook.
- **Claude Haiku only** — no Sonnet. Prompt caching disabled (4,096 token minimum; our prompt is ~35 tokens).
- **Two-layer filter before Claude** — keyword match AND signal phrase match required. Claude never called on noise.
- **Post ID deduplication** — extract numeric post ID from URL, not full URL (Facebook has multiple URL formats for same post).

## Code Conventions (Non-Negotiable)
- All credentials via environment variables — never hardcoded, never in comments
- Every async function has explicit try/catch with meaningful error messages
- Each Facebook group scrape is wrapped independently — one group failure must not kill the run
- `config.js` validates ALL required env vars on startup and exits with a named error if any are missing
- `max_tokens: 80` on every Claude API call — hard server-side cap, no exceptions
- Log every run summary to `logs/` with: timestamp, groups checked, posts found, leads logged, duration
- **Always use `path.join()` for file paths — never string concatenation** (ensures Windows compatibility)
- Business hours check at top of `index.js` — exit immediately if outside 8am–9pm regardless of scheduler

## What NOT to Change Without Asking
- `session/` directory — contains active Facebook login session
- `data/seen_posts.json` — deduplication state; deleting causes re-processing of recent posts
- `src/facebook/auth.js` — login verification logic; changes here can break session persistence
- `.env` — credentials file

## Cross-Platform Notes (Mac + Windows)
- Node.js code is 100% identical on both platforms
- **Mac scheduling**: PM2 cron (`ecosystem.config.js`)
- **Windows scheduling**: Windows Task Scheduler (no PM2 needed — GUI setup, zero extra packages)
- **Mac sleep prevention**: System Settings → Energy Saver → never sleep on power adapter
- **Windows sleep prevention**: Power Options → Change plan settings → never sleep
- `ecosystem.config.js` is Mac-only — Windows users ignore it
- README has two setup sections: Mac Setup and Windows Setup
- Headed browser mode (`headless: false`) works identically on both — both have displays

## Bot Detection Mitigation (Facebook)
- **Headed mode on Mac/Windows** (`headless: false`) — dramatically reduces detection vs headless
- **Randomised delays**: 45–90 seconds between groups (not fixed), 3–7 seconds between scrolls
- **Shuffle group order** each run — never visit in the same sequence
- **Max 15 groups per run** — hard limit regardless of how many are configured
- **Read-only behaviour** — no posting, liking, commenting, following at any time
- **Checkpoint detection after every group load**: CAPTCHA → Teams alert + exit; `/checkpoint/` URL → Teams alert + exit; login redirect → attempt re-login; "content unavailable" → skip + continue
- **Zero-posts signal**: if 3+ consecutive groups return zero posts, send Teams warning and exit — likely detected
- **playwright-extra stealth plugin** — masks JS-level headless signals (navigator.webdriver etc.)
- **Residential IP** (home/office Mac) is a significant trust signal — do not run from VPN or datacenter

## Gotchas — What Claude Gets Wrong Here
- **Teams format** — Adaptive Card format only. Confirmed working 2026-05-20. Simple `{"text":"..."}` returns 202 but posts nothing. Must send full Adaptive Card JSON with `"type":"AdaptiveCard"` at root. See teams/alert.js for the exact card structure.
- **Playwright session bug #36139** — session cookies may not persist. Always verify login AFTER loading session (check for logged-in page element), re-login if verification fails.
- **PM2 persistence** — `pm2 startup` alone is NOT enough. Must also run `pm2 save` after starting the process or it will not survive reboot.
- **Facebook URL formats** — same post can have 3+ different URLs. Deduplicate by numeric post ID extracted from URL, never by full URL string.
- **Facebook vanity URL vs numeric group ID** — `facebook.com/groups/my-group-name` and `facebook.com/groups/123456789` can be the same group. Facebook redirects the vanity URL to the numeric ID. If both are in the Groups sheet, the group is scraped twice every run. Always use the numeric ID; remove any vanity URL duplicates.
- **GraphQL `creation_time` extraction — do NOT use `findDeep(obj, 'creation_time')` on the full Story object.** Facebook Stories can contain nested linked articles or shared posts, each with their own `creation_time`. `findDeep` may return the wrong one (e.g. the linked article's date, not the post's date), producing timestamps that are months off. Always search `comet_sections.timestamp` subtree first: `findDeep(obj.comet_sections?.timestamp ?? obj, 'creation_time')`.
- **DOM vs GraphQL post IDs use different formats** — DOM extraction gives numeric IDs (from `/posts/123456`); GraphQL gives BASE64-encoded IDs (`UzpfST...`). These never match in a Set comparison even for the same post. The merge logic (`graphqlOnly = graphqlPosts.filter(p => !domIds.has(p.id))`) does not deduplicate across the two sources — the same post can appear in both halves of the merged array with different IDs.
- **Google Sheets batchGet** — always read Config + Keywords + Groups tabs in ONE batchGet call, not three separate calls.
- **Lock file cleanup** — if script is killed mid-run, lock file remains. Startup must check lock file age: if older than 25 minutes, treat as stale and delete it.
- **Claude fallback** — if Claude fails after 2 retries, send Teams alert anyway with "Draft unavailable" message. Never drop a lead because Claude is down.
- **Mac Energy Saver** — must be set to never sleep on power adapter. If not set, cron runs are silently skipped.

## Teams Webhook — Confirmed Setup (do not change without re-testing)
- **How to create:** Inside Teams → hover channel name → `...` → Workflows → search "webhook" → "Post to a channel when a webhook request is received" → save → copy URL
- **Power Automate website (make.powerautomate.com) is NOT the right place** — the HTTP trigger there requires a paid Premium licence ($15/user/month) and is not available on standard Microsoft 365
- **URL format:** `https://default[env].7c.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/[id]/triggers/manual/paths/invoke?api-version=1&sp=...&sv=1.0&sig=...` — the `sig=` parameter is the SAS token (authentication built into URL)
- **Payload:** Must be a full Adaptive Card JSON object with `"type": "AdaptiveCard"` at root — sending `{"text":"..."}` returns HTTP 202 but posts nothing to the channel (silent failure)
- **Test tool:** hoppscotch.io — POST method, application/json body

## Known Issues
- playwright-extra stealth plugin (Node.js) last updated 2023 — may not catch all modern detection signals. Monitor for sudden zero-post runs.
- Power Automate Workflows webhook rate limit unknown — add 3-second delay between consecutive Teams posts.

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
