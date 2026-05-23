'use strict';

const path = require('path');
const { google } = require('googleapis');
const config = require('../config');

let _sheets = null;

async function getSheetsClient() {
  if (_sheets) return _sheets;

  const credentialsPath = path.resolve(config.googleCredentialsPath);
  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  _sheets = google.sheets({ version: 'v4', auth });
  return _sheets;
}

async function appendLead(lead) {
  try {
    const sheets = await getSheetsClient();
    const row = [
      lead.timestamp,
      lead.groupName,
      lead.postText,
      lead.postUrl,
      lead.postId,
      lead.draftReply || '',
      lead.status || 'New',
      '',
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: config.googleSheetId,
      range: 'Leads!A:H',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
  } catch (err) {
    throw new Error(`[sheets] appendLead failed: ${err.message}`);
  }
}

// One batchGet call for all config tabs
async function loadConfig() {
  try {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: config.googleSheetId,
      ranges: ['Config!A:B', 'Keywords!A:A', 'Groups!A:A', 'Signal Phrases!A:A', 'Disqualifiers!A:A', 'Competitor Signals!A:A'],
    });

    const [configRange, keywordsRange, groupsRange, signalRange, disqualifiersRange, competitorSignalsRange] = res.data.valueRanges;

    // Config tab: key → value pairs
    const configMap = {};
    for (const row of (configRange.values || [])) {
      if (row[0] && row[1]) configMap[row[0].trim()] = row[1].trim();
    }

    const keywords = (keywordsRange.values || [])
      .map(r => r[0]?.trim().toLowerCase()).filter(Boolean);

    const groups = (groupsRange.values || [])
      .map(r => r[0]?.trim()).filter(v => v && v.startsWith('http'));

    const signalPhrases = (signalRange.values || [])
      .map(r => r[0]?.trim().toLowerCase()).filter(Boolean);

    const sheetDisqualifiers = (disqualifiersRange.values || [])
      .map(r => r[0]?.trim().toLowerCase()).filter(Boolean);

    const competitorSignals = (competitorSignalsRange.values || [])
      .map(r => r[0]?.trim().toLowerCase()).filter(Boolean);

    const rawFreq = parseInt(configMap['Link Frequency (%)'] || '40', 10);

    // Run Times: comma-separated 24-hour values, e.g. "8,12,17"
    // Defaults to 8am / 12pm / 5pm if the key is absent from the sheet.
    const runTimes = (configMap['Run Times'] || '8,12,17')
      .split(',')
      .map(t => parseInt(t.trim(), 10))
      .filter(t => !isNaN(t) && t >= 0 && t <= 23);

    return {
      systemPrompt: configMap['Claude System Prompt'] || null,
      businessHoursStart: parseInt(configMap['Business Hours Start'] || '8', 10),
      businessHoursEnd: parseInt(configMap['Business Hours End'] || '21', 10),
      maxPostAgeHours: parseInt(configMap['Max Post Age (hours)'] || '24', 10),
      fbPageUrl: configMap['FB Page URL'] || null,
      linkProbability: Math.min(100, Math.max(0, isNaN(rawFreq) ? 40 : rawFreq)) / 100,
      monitorEnabled: (configMap['Monitor Enabled'] || 'Yes').trim().toLowerCase() !== 'no',
      commentAlertThreshold: parseInt(configMap['Comment Alert Threshold'] || '5', 10),
      likeAlertThreshold: parseInt(configMap['Like Alert Threshold'] || '2', 10),
      runTimes,
      keywords,
      groups,
      signalPhrases,
      disqualifiers: sheetDisqualifiers,
      competitorSignals,
    };
  } catch (err) {
    throw new Error(`[sheets] loadConfig failed: ${err.message}`);
  }
}

module.exports = { appendLead, loadConfig };
