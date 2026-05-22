'use strict';

// Hardcoded baseline — always active regardless of Sheet content
const BASE_DISQUALIFIERS = [
  'fake news', 'breaking news', 'fyi', 'just sharing', 'rant',
  'opinion ko lang', 'just my opinion',
  // Welcome-new-member posts — group automated or manual, never a lead
  'welcome new member', 'welcome our new member', 'welcome our newest member',
  'let\'s welcome', "let's welcome", 'please welcome',
  'welcome to the group', 'welcome to our group', 'welcome to the community',
  'bagong miyembro', 'maligayang pagdating sa grupo', 'maligayang pagdating sa aming grupo',
];

// sheetDisqualifiers and competitorSignals come from Google Sheet tabs at runtime.
// commentText is the combined text of all visible comments on the post.
function isRelevant(post, keywords, signalPhrases, sheetDisqualifiers = [], competitorSignals = [], commentText = '', commentAlertThreshold = 5, likeAlertThreshold = 2) {
  const lower = post.text.toLowerCase();

  const commentCount = post.commentCount || 0;
  const likeCount = post.likeCount || 0;
  const isHighActivity = commentCount >= commentAlertThreshold || likeCount >= likeAlertThreshold;

  const allDisqualifiers = [...BASE_DISQUALIFIERS, ...sheetDisqualifiers];
  const hasDisqualifier = allDisqualifiers.some(d => lower.includes(d));

  // High activity bypasses length, keyword, and signal checks — only disqualifiers can block it
  if (isHighActivity) {
    if (hasDisqualifier) return { pass: false, reason: 'disqualifier matched' };
    return { pass: true, competitorSignal: false, highActivity: true, commentCount, likeCount, reason: null };
  }

  // For normal posts: apply all filters in order
  if (hasDisqualifier) return { pass: false, reason: 'disqualifier matched' };

  const hasKeyword = keywords.some(k => lower.includes(k));
  if (!hasKeyword) return { pass: false, reason: 'no keyword' };

  // Competitor signal in post text OR comments
  if (competitorSignals.length > 0) {
    const lowerComments = commentText.toLowerCase();
    const hasCompetitorSignal =
      competitorSignals.some(c => lower.includes(c)) ||
      (commentText && competitorSignals.some(c => lowerComments.includes(c)));
    if (hasCompetitorSignal) return { pass: true, competitorSignal: true, highActivity: false, commentCount, likeCount, reason: null };
  }

  return { pass: true, competitorSignal: false, highActivity: false, commentCount, likeCount, reason: null };
}

module.exports = { isRelevant };
