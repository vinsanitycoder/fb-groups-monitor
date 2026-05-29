'use strict';

const path = require('path');
const config = require('../config');

// Absolute path to the project root — used in the session-expired card
const PROJECT_PATH = path.resolve(__dirname, '..', '..');

function phTime(date, includeDate = false) {
  return date.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    ...(includeDate ? { month: 'short', day: 'numeric' } : {}),
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Turns a timestamp into a human label for the Teams card.
// Handles two input formats:
//   • Facebook DOM relative labels: "2h", "36m", "1d", "Monday at 3:00 PM"
//   • ISO 8601 strings from GraphQL: "2026-05-21T06:13:00.000Z"
function buildPostedLabel(postedAt, notificationTimestamp) {
  if (!postedAt) return '';

  const notifTime = new Date(notificationTimestamp);

  // ISO timestamp from GraphQL — convert to a relative + absolute label
  if (/^\d{4}-\d{2}-\d{2}T/.test(postedAt)) {
    const postTime = new Date(postedAt);
    const diffMs = notifTime - postTime;
    const diffMins = Math.round(diffMs / 60000);
    if (diffMins < 1) return `just now (~${phTime(postTime)})`;
    if (diffMins < 60) return `${diffMins}m ago (~${phTime(postTime)})`;
    if (diffMins < 1440) return `${Math.round(diffMins / 60)}h ago (~${phTime(postTime)})`;
    return `${Math.round(diffMins / 1440)}d ago (~${phTime(postTime, true)})`;
  }

  // Already has explicit time info — no calculation needed
  if (/\bat\b|AM|PM/i.test(postedAt)) return postedAt;

  const minsMatch  = postedAt.match(/^(\d+)\s*m$/i);
  const hoursMatch = postedAt.match(/^(\d+)\s*h$/i);
  const daysMatch  = postedAt.match(/^(\d+)\s*d$/i);

  if (minsMatch) {
    const approx = new Date(notifTime - parseInt(minsMatch[1]) * 60 * 1000);
    return `${postedAt} (~${phTime(approx)})`;
  }
  if (hoursMatch) {
    const approx = new Date(notifTime - parseInt(hoursMatch[1]) * 60 * 60 * 1000);
    return `${postedAt} (~${phTime(approx)})`;
  }
  if (daysMatch) {
    const approx = new Date(notifTime - parseInt(daysMatch[1]) * 24 * 60 * 60 * 1000);
    return `${postedAt} (~${phTime(approx, true)})`;
  }

  return postedAt; // unknown format — show as-is
}

async function sendLeadAlert(lead) {
  const { default: fetch } = await import('node-fetch');

  const draft = lead.draftReply || 'Draft unavailable — Claude API error.';
  const timestamp = new Date(lead.timestamp).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const groupLabel = lead.groupName.length > 32
    ? lead.groupName.slice(0, 32) + '…'
    : lead.groupName;
  const snippet = lead.postText.slice(0, 120).replace(/\n+/g, ' ').trim();
  const ellipsis = lead.postText.length > 120 ? '…' : '';

  // Build "posted X (~approx time)" label from Facebook's relative timestamp
  const postedLabel = buildPostedLabel(lead.postedAt, lead.timestamp);

  const body = [];

  if (lead.highActivity) {
    body.push({
      type: 'TextBlock',
      text: `🔥 ${[lead.commentCount && `${lead.commentCount} comments`, lead.likeCount && `${lead.likeCount} likes`].filter(Boolean).join(' · ')} — high activity, move fast`,
      color: 'Warning',
      weight: 'Bolder',
      wrap: true,
    });
  }

  if (lead.competitorSignal) {
    body.push({
      type: 'TextBlock',
      text: '⚡ Competitor already responding — move fast',
      color: 'Warning',
      weight: 'Bolder',
      wrap: true,
    });
  }

  body.push(
    {
      type: 'TextBlock',
      text: `🔔 New lead · ${timestamp}`,
      weight: 'Bolder',
      wrap: true,
    },
    {
      type: 'TextBlock',
      text: `📍 ${groupLabel}${postedLabel ? `  ·  posted ${postedLabel}` : ''}`,
      isSubtle: true,
      size: 'Small',
      spacing: 'None',
    },
    {
      type: 'TextBlock',
      text: `"${snippet}${ellipsis}"`,
      wrap: true,
      spacing: 'Small',
      isSubtle: true,
    },
    {
      type: 'TextBlock',
      text: `💬 ${draft}`,
      wrap: true,
      spacing: 'Small',
    },
    {
      type: 'ActionSet',
      spacing: 'Small',
      actions: [
        {
          type: 'Action.OpenUrl',
          title: 'Open post',
          url: lead.postUrl,
        },
      ],
    },
  );

  const card = {
    type: 'AdaptiveCard',
    version: '1.4',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    body,
  };

  try {
    const res = await fetch(config.teamsWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    throw new Error(`[teams] sendLeadAlert failed: ${err.message}`);
  }
}

async function sendSystemAlert(title, message) {
  const { default: fetch } = await import('node-fetch');

  const timestamp = new Date().toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const card = {
    type: 'AdaptiveCard',
    version: '1.4',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    body: [
      {
        type: 'TextBlock',
        text: title,
        weight: 'Bolder',
        size: 'Medium',
        wrap: true,
      },
      {
        type: 'TextBlock',
        text: timestamp,
        isSubtle: true,
        spacing: 'None',
      },
      {
        type: 'TextBlock',
        text: message,
        wrap: true,
        spacing: 'Medium',
      },
    ],
  };

  try {
    const res = await fetch(config.teamsWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    throw new Error(`[teams] sendSystemAlert failed: ${err.message}`);
  }
}

async function sendSessionExpiredAlert() {
  const { default: fetch } = await import('node-fetch');

  const timestamp = new Date().toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const card = {
    type: 'AdaptiveCard',
    version: '1.4',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    body: [
      {
        type: 'TextBlock',
        text: '⚠️ FB Monitor — Needs Re-Login',
        weight: 'Bolder',
        size: 'Large',
        color: 'Warning',
        wrap: true,
      },
      {
        type: 'TextBlock',
        text: timestamp,
        isSubtle: true,
        spacing: 'None',
      },
      {
        type: 'TextBlock',
        text: 'Facebook logged out the monitor. It has stopped running. Follow the steps below exactly to get it running again — takes about 2 minutes.',
        wrap: true,
        spacing: 'Medium',
      },

      // ── Step 1 ──────────────────────────────────────────────────────────────
      {
        type: 'TextBlock',
        text: 'STEP 1 — Open Terminal',
        weight: 'Bolder',
        spacing: 'Large',
        color: 'Accent',
      },
      {
        type: 'TextBlock',
        text: 'Press the Command key (⌘) and the Space bar at the same time. A search box appears. Type the word Terminal and press Enter. A window with a black or white background will open — that is Terminal.',
        wrap: true,
        spacing: 'Small',
      },

      // ── Step 2 ──────────────────────────────────────────────────────────────
      {
        type: 'TextBlock',
        text: 'STEP 2 — Go to the monitor folder',
        weight: 'Bolder',
        spacing: 'Large',
        color: 'Accent',
      },
      {
        type: 'TextBlock',
        text: 'Click inside the Terminal window, then copy and paste the line below exactly as shown and press Enter:',
        wrap: true,
        spacing: 'Small',
      },
      {
        type: 'TextBlock',
        text: `cd "${PROJECT_PATH}"`,
        fontType: 'Monospace',
        color: 'Good',
        spacing: 'Small',
        wrap: true,
      },

      // ── Step 3 ──────────────────────────────────────────────────────────────
      {
        type: 'TextBlock',
        text: 'STEP 3 — Run the login script',
        weight: 'Bolder',
        spacing: 'Large',
        color: 'Accent',
      },
      {
        type: 'TextBlock',
        text: 'Copy and paste this next line into Terminal and press Enter:',
        wrap: true,
        spacing: 'Small',
      },
      {
        type: 'TextBlock',
        text: 'node scripts/login.js',
        fontType: 'Monospace',
        color: 'Good',
        spacing: 'Small',
      },
      {
        type: 'TextBlock',
        text: 'A browser window will open on Facebook. Log in normally with the monitoring account email and password. If Facebook asks for a verification code or shows a security check, complete it. The browser will close by itself once it is done.',
        wrap: true,
        spacing: 'Small',
      },

      // ── Step 4 ──────────────────────────────────────────────────────────────
      {
        type: 'TextBlock',
        text: 'STEP 4 — Restart the monitor',
        weight: 'Bolder',
        spacing: 'Large',
        color: 'Accent',
      },
      {
        type: 'TextBlock',
        text: 'After the browser closes, go back to Terminal and paste this last line, then press Enter:',
        wrap: true,
        spacing: 'Small',
      },
      {
        type: 'TextBlock',
        text: 'pm2 start ecosystem.config.js',
        fontType: 'Monospace',
        color: 'Good',
        spacing: 'Small',
      },
      {
        type: 'TextBlock',
        text: '✅ The monitor is running again. You will receive the usual daily startup message at 8 AM to confirm.',
        wrap: true,
        spacing: 'Medium',
        color: 'Good',
      },
    ],
  };

  try {
    const res = await fetch(config.teamsWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    throw new Error(`[teams] sendSessionExpiredAlert failed: ${err.message}`);
  }
}

// Compact status card sent at the end of every real run.
// Gives the team a visible heartbeat — if the channel goes quiet they know
// something is wrong. Intentionally small so it does not compete with lead cards.
async function sendRunSummaryAlert(summary) {
  const { default: fetch } = await import('node-fetch');

  const time = new Date(summary.runAt).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    timeStyle: 'short',
  });

  const hasErrors  = summary.errors.length > 0;
  const leadWord   = summary.leadsLogged === 1 ? '1 new lead' : `${summary.leadsLogged} new leads`;
  const icon       = hasErrors ? '⚠️' : (summary.leadsLogged > 0 ? '🔔' : '✅');
  const statusLine = `${icon} ${time} — ${summary.groupsChecked} groups scanned · ${leadWord}`;

  const body = [
    {
      type: 'TextBlock',
      text: statusLine,
      wrap: true,
      color: hasErrors ? 'Warning' : 'Default',
      isSubtle: !hasErrors && summary.leadsLogged === 0,
    },
  ];

  if (hasErrors) {
    body.push({
      type: 'TextBlock',
      text: summary.errors.slice(0, 2).join(' · '),
      wrap: true,
      isSubtle: true,
      size: 'Small',
      spacing: 'None',
    });
  }

  const card = {
    type: 'AdaptiveCard',
    version: '1.4',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    body,
  };

  try {
    const res = await fetch(config.teamsWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  } catch (err) {
    throw new Error(`[teams] sendRunSummaryAlert failed: ${err.message}`);
  }
}

module.exports = { sendLeadAlert, sendSystemAlert, sendSessionExpiredAlert, sendRunSummaryAlert };
