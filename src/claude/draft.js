'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');

const client = new Anthropic({ apiKey: config.anthropicApiKey });

const SYSTEM_PROMPT_NO_LINK =
  'PH accounting/BIR startup. Write ONE casual Facebook reply, max 12 words. Acknowledge their specific need, end with "DM us po" or "PM us po". No intro, no hashtags, sound like a real person not a company.';

const SYSTEM_PROMPT_WITH_LINK =
  'PH accounting/BIR startup. Write ONE casual Facebook reply, max 12 words. Acknowledge their specific need, end with "Visit our page din po:" or "Check us out din po:". No intro, no hashtags, sound like a real person not a company.';

// fbPageUrl, linkProbability, and sheetSystemPrompt come from the Google Sheet Config tab.
// sheetSystemPrompt overrides the hardcoded prompts when set; falls back to hardcoded if null.
async function generateDraft(postText, fbPageUrl = null, linkProbability = 0.4, sheetSystemPrompt = null) {
  const clean = postText
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);

  const includeLink = !!fbPageUrl && Math.random() < linkProbability;
  const systemPrompt = sheetSystemPrompt
    ? sheetSystemPrompt
    : (includeLink ? SYSTEM_PROMPT_WITH_LINK : SYSTEM_PROMPT_NO_LINK);
  const maxTokens = includeLink ? 80 : 40;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const message = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Post: "${clean}"` }],
      });

      let draft = message.content[0].text.trim();

      // Append the actual URL so Claude never has to reproduce it
      if (includeLink) {
        draft = `${draft} ${fbPageUrl}`;
      }

      return draft;
    } catch (err) {
      if (attempt === 2) {
        console.error(`[claude] generateDraft failed after 2 attempts: ${err.message}`);
        return null;
      }
    }
  }
}

module.exports = { generateDraft };
