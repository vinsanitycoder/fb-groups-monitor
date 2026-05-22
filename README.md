# Facebook Groups Monitor

Every day, potential clients post in Facebook groups asking for exactly what you offer — *"looking for a good accountant"*, *"anyone know a reliable bookkeeper?"* — and most of those posts go unanswered within the hour. The person picks whoever replies first.

This tool watches those groups for you, around the clock. The moment a matching post appears, your team gets a Teams notification with a direct link to the post and an AI-drafted reply ready to send. No more manually checking Facebook. No more missed leads.

**It takes about an hour to set up. After that, it runs on its own.**

---

## What it does

- Checks your list of Facebook groups every 30 minutes during business hours
- Spots posts that match your keywords — you control the list (e.g. "need accountant", "BIR registration", "looking for bookkeeper")
- Ignores ads, job postings, and spam automatically — you control what to filter out
- Sends your team a Teams alert the moment a real lead is found, with a direct link to the post
- Drafts a personalised reply using AI — your team reviews it, edits if needed, and posts it from their own Facebook account
- Saves every lead to a Google Sheet automatically — post text, group, timestamp, and the draft reply
- Never alerts you about the same post twice, even if it appears in multiple groups

---

## Requirements

- A Mac or Windows computer that stays on during business hours
- A dedicated Facebook account for monitoring (not your personal account)
- A Google account with access to Google Sheets
- A Microsoft Teams channel
- An Anthropic API key (for Claude draft replies) — get one at [console.anthropic.com](https://console.anthropic.com)

---

## Table of Contents

1. [Google Sheets Setup](#1-google-sheets-setup)
2. [Teams Webhook Setup](#2-teams-webhook-setup)
3. [Mac Setup](#3-mac-setup)
4. [Windows Setup](#4-windows-setup)
5. [Daily Operations](#5-daily-operations)
6. [Troubleshooting](#6-troubleshooting)

---

## 1. Google Sheets Setup

Create a new Google Sheet. It needs the following tabs — the names must match exactly.

---

### Tabs required

**Config** — key/value settings (column A = key, column B = value)

| Key | Example value | Description |
|-----|---------------|-------------|
| Monitor Enabled | Yes | Change to `No` to pause the monitor |
| Business Hours Start | 8 | Hour to start monitoring (24-hour clock) |
| Business Hours End | 21 | Hour to stop monitoring (24-hour clock) |
| Max Post Age (hours) | 24 | Ignore posts older than this |
| FB Page URL | https://facebook.com/yourpage | Optional — appended to some draft replies |
| Link Frequency (%) | 40 | 0–100. How often to include the page link in drafts |
| Claude System Prompt | | Optional — overrides the default AI prompt |
| Comment Alert Threshold | 5 | Posts with this many comments are flagged as high activity |
| Like Alert Threshold | 2 | Posts with this many likes are flagged as high activity |

**Keywords** — one keyword or phrase per row in column A. Case-insensitive. Example:
```
looking for accountant
need bookkeeper
BIR registration
```

**Groups** — one Facebook group URL per row in column A. Use numeric group IDs, not vanity URLs. Example:
```
https://www.facebook.com/groups/123456789
https://www.facebook.com/groups/987654321
```

**Signal Phrases** — reserved for future use, leave empty for now or add phrases that indicate buying intent.

**Disqualifiers** — one word or phrase per row in column A. Posts containing any of these are skipped. Example:
```
hiring
job opening
we are looking for applicants
```

**Competitor Signals** — one word or phrase per row in column A. If found in a post or its comments, the Teams card is flagged as a competitor alert.

**Leads** — leave this tab empty. The monitor writes to it automatically. Columns: Timestamp, Group, Post Text, Post URL, Post ID, Draft Reply, Status, Claimed By.

---

### Give the monitor access to your Sheet

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project
2. Enable the **Google Sheets API** for the project
3. Create a **Service Account** (IAM & Admin → Service Accounts → Create)
4. Download the JSON key file for the service account
5. In your Google Sheet, click **Share** and share it with the service account email address (looks like `name@project.iam.gserviceaccount.com`) — give it **Editor** access
6. Copy the Sheet ID from the URL — it is the long string between `/d/` and `/edit` in the address bar

---

## 2. Teams Webhook Setup

The monitor uses Power Automate Workflows webhooks (not the deprecated Incoming Webhooks).

1. Open Microsoft Teams
2. Go to the channel where you want lead alerts
3. Hover over the channel name and click `...` → **Workflows**
4. Search for **"webhook"**
5. Select **"Post to a channel when a webhook request is received"**
6. Follow the steps and click Save
7. Copy the webhook URL — it starts with `https://` and is very long

> **Note:** The webhook URL is your authentication key. Keep it private — anyone with the URL can post to your channel.

---

## 3. Mac Setup

Follow every step in order.

---

### Step 1 — Install Node.js

Node.js is the engine that runs the monitor. You only install this once.

1. Open your browser and go to **https://nodejs.org**
2. Click the big green **LTS** button to download
3. Open the downloaded file and follow the installer
4. When it finishes, click Close

**Verify it worked:**
1. Press **Cmd + Space**, type `Terminal`, press Enter
2. Type the following and press Enter:
   ```
   node --version
   ```
3. You should see something like `v20.11.0` — any v20 or higher is correct

---

### Step 2 — Download the project

Download or clone this repository to your computer. For example, put it on your Desktop.

Open Terminal and navigate to the project folder. Replace the path below with wherever you saved it:
```
cd ~/Desktop/fb_lead_monitor
```

> Every command in this guide must be run from inside the project folder. If you open a new Terminal window, run this `cd` command again first.

---

### Step 3 — Install dependencies

Run these two commands one at a time — wait for each to finish:

```
npm install
```

```
npx playwright install chromium
```

The second command downloads the browser the monitor uses. It may take a few minutes.

---

### Step 4 — Fill in your credentials

1. Open the project folder in Finder
2. Press **Cmd + Shift + .** (dot) to show hidden files
3. Right-click the `.env` file and open it with TextEdit
4. Fill in all six values:

```
FB_EMAIL=monitoring-account@gmail.com
FB_PASSWORD=your-password
GOOGLE_CREDENTIALS_PATH=./google-credentials.json
GOOGLE_SHEET_ID=paste-your-sheet-id-here
TEAMS_WEBHOOK_URL=https://your-webhook-url-here
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

5. Save and close

Also copy your Google service account JSON key file into the project folder and name it `google-credentials.json`.

---

### Step 5 — Log in to Facebook

The monitor needs a saved Facebook session to run without prompting each time.

In Terminal (make sure you are in the project folder), run:
```
node scripts/login.js
```

A browser window will open on Facebook. Log in manually using the monitoring account. If Facebook asks for a verification code, enter it. The browser will close automatically once the session is saved.

---

### Step 6 — Install PM2

PM2 runs the monitor on a schedule and restarts it after reboots.

```
sudo npm install -g pm2
```

Enter your Mac login password when prompted (nothing appears as you type — that is normal).

---

### Step 7 — Start the scheduler

Run these one at a time:

```
pm2 start ecosystem.config.js
```

```
pm2 startup
```

The second command prints a long line starting with `sudo env PATH=...`. Copy the entire line, paste it into Terminal, and press Enter. Enter your password when prompted.

```
pm2 save
```

You should see `[PM2] Successfully saved`.

---

### Step 8 — Prevent the Mac from sleeping

1. Click the Apple menu → **System Settings**
2. Click **Battery** → **Options**
3. Turn on **"Prevent automatic sleeping when display is off"**

If this is a laptop, keep it plugged in — this setting only works on power.

---

### Step 9 — Confirm

Run:
```
pm2 status
```

You should see `fb-monitor` in the list. The next morning at your configured start time, you will receive a Teams message: **"FB Monitor — Started"**. That confirms everything is working.

---

## 4. Windows Setup

The monitor works on Windows using Task Scheduler instead of PM2.

---

### Step 1 — Install Node.js

1. Go to **https://nodejs.org**, click the **LTS** download
2. Run the installer — on the "Tools for Native Modules" screen, check **"Automatically install the necessary tools"**
3. Verify: press the Windows key, type `cmd`, open Command Prompt, and run `node --version`

---

### Step 2 — Open Command Prompt in the project folder

1. Press the Windows key, type `cmd`, press Enter
2. Navigate to the project folder:
   ```
   cd "C:\Users\YourName\Desktop\fb_lead_monitor"
   ```

---

### Step 3 — Install dependencies

```
npm install
```
```
npx playwright install chromium
```

---

### Step 4 — Fill in credentials

1. Open File Explorer → View → check **Hidden items**
2. Find and open the `.env` file with Notepad
3. Fill in all six values (same as Mac Step 4 above)
4. Copy your `google-credentials.json` file into the project folder

---

### Step 5 — Log in to Facebook

```
node scripts/login.js
```

Log in manually in the browser window that opens.

---

### Step 6 — Prevent sleeping

Control Panel → Power Options → Change plan settings → set both sleep options to **Never**.

---

### Step 7 — Create a scheduled task

1. Press the Windows key, type `Task Scheduler`, press Enter
2. Click **Create Basic Task** in the right panel
3. Fill in the wizard:
   - **Name:** `FB Lead Monitor`
   - **Trigger:** Daily, start at 8:00 AM
   - **Action:** Start a program
   - **Program/script:** `node`
   - **Arguments:** `src/index.js`
   - **Start in:** full path to your `fb_lead_monitor` folder
4. After creating, double-click the task → **Triggers** tab → Edit the trigger
5. Check **"Repeat task every"** → set to **30 minutes**, duration **13 hours**
6. Click OK

Test it by right-clicking the task and choosing **Run**.

---

## 5. Daily Operations

### Pause or resume the monitor

Open your Google Sheet → **Config** tab → change `Monitor Enabled` from `Yes` to `No` (or back).
Changes take effect on the next scheduled run. No Terminal needed.

---

### Add Facebook groups

Google Sheet → **Groups** tab → paste the group URL in a new row.
Use the numeric group ID URL format: `https://www.facebook.com/groups/123456789`

---

### Add or remove keywords

Google Sheet → **Keywords** tab → add or delete entries (one per row, not case-sensitive).

---

### Claim a lead

1. Find the Teams card in your alerts channel
2. Click **Open post** to go directly to the Facebook post
3. Reply from your own personal account using the AI draft as a starting point
4. Mark the lead as `Claimed` in the Google Sheet → Leads tab

---

### Re-login when the session expires

If the Facebook session expires, the monitor will send a Teams alert with step-by-step instructions. In summary:

```
node scripts/login.js
```

Log in manually, then:

```
pm2 start ecosystem.config.js
```

---

### Check monitor status (Mac)

```
pm2 status
pm2 logs fb-monitor --lines 50
```

---

## 6. Troubleshooting

---

**Teams alerts have stopped**

Run `pm2 logs fb-monitor --lines 50` and look for errors. Common causes:
- `CHECKPOINT_DETECTED` — Facebook flagged the account. Log in manually at facebook.com and complete any security check
- All groups showing `0 posts` — possible bot detection. Wait 1–2 hours

---

**Monitor stopped after a reboot**

```
pm2 resurrect
```

If that does not work:
```
pm2 start ecosystem.config.js
pm2 save
```

---

**Lock file error on startup**

A previous run did not finish cleanly. Open the `data` folder and delete `run.lock`, then the next run will proceed normally.

---

**No leads appearing**

- Check that your keywords match how people actually write in the groups (run `node scripts/check-keywords.js` to test)
- Run `node src/index.js` manually to see exactly what the monitor does in real time

---

**Teams webhook stopped working**

The webhook URL may have expired. Go to the Teams channel → `...` → Workflows, delete the old webhook and create a new one. Update `TEAMS_WEBHOOK_URL` in your `.env` file.

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `FB_EMAIL` | Email of the Facebook monitoring account |
| `FB_PASSWORD` | Password for the Facebook monitoring account |
| `GOOGLE_CREDENTIALS_PATH` | Path to the Google service account JSON key file |
| `GOOGLE_SHEET_ID` | The ID from your Google Sheet URL |
| `TEAMS_WEBHOOK_URL` | Power Automate Workflows webhook URL |
| `ANTHROPIC_API_KEY` | Claude API key from console.anthropic.com |

---

## License

MIT
