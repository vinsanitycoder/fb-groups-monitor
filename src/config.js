'use strict';

require('dotenv').config({ override: true });

const REQUIRED = [
  'FB_EMAIL',
  'FB_PASSWORD',
  'GOOGLE_CREDENTIALS_PATH',
  'GOOGLE_SHEET_ID',
  'TEAMS_WEBHOOK_URL',
  'ANTHROPIC_API_KEY',
];

for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`[config] Missing required env var: ${key}`);
    process.exit(1);
  }
}

module.exports = {
  fbEmail: process.env.FB_EMAIL,
  fbPassword: process.env.FB_PASSWORD,
  googleCredentialsPath: process.env.GOOGLE_CREDENTIALS_PATH,
  googleSheetId: process.env.GOOGLE_SHEET_ID,
  teamsWebhookUrl: process.env.TEAMS_WEBHOOK_URL,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
};
