'use strict';

// Diagnostic script — loads keywords from Google Sheets and tests them against
// a post text you provide. Run it with:
//
//   node scripts/check-keywords.js
//
// Then paste in any post text when prompted.

require('dotenv').config({ override: true });
const readline = require('readline');
const { loadConfig } = require('../src/sheets/client');

async function main() {
  console.log('\nLoading config from Google Sheets...\n');
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error('Failed to load config:', err.message);
    process.exit(1);
  }

  const { keywords, signalPhrases, disqualifiers } = config;

  console.log(`Loaded ${keywords.length} keywords:`);
  keywords.forEach((k, i) => console.log(`  ${i + 1}. "${k}"`));

  console.log(`\nLoaded ${signalPhrases.length} signal phrases:`);
  signalPhrases.forEach((p, i) => console.log(`  ${i + 1}. "${p}"`));

  console.log(`\nLoaded ${disqualifiers.length} disqualifiers from sheet (plus 7 hardcoded baseline).\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  function ask() {
    console.log('─'.repeat(60));
    console.log('Paste a post text (multi-line OK) then press Enter twice, or type "exit":');
    process.stdout.write('> ');

    const lines = [];
    rl.on('line', (line) => {
      if (line.trim().toLowerCase() === 'exit') {
        rl.close();
        return;
      }
      // Blank line = end of input
      if (line.trim() === '' && lines.length > 0) {
        rl.removeAllListeners('line');
        run(lines.join('\n'));
        return;
      }
      if (line.trim() !== '') lines.push(line);
    });

    function run(input) {
      const text = input.trim();
      if (!text) { ask(); return; }

      const lower = text.toLowerCase();

      // Keyword check
      const matchedKeywords = keywords.filter(k => lower.includes(k));
      if (matchedKeywords.length) {
        console.log(`\n✅ KEYWORD MATCH: ${matchedKeywords.map(k => `"${k}"`).join(', ')}`);
      } else {
        console.log('\n❌ NO KEYWORD MATCH');
        // Show near-misses: keywords where at least half the chars appear in order
        const nearMisses = keywords.filter(k => {
          // simple check: keyword without spaces matches
          return lower.includes(k.replace(/\s+/g, ''));
        });
        if (nearMisses.length) {
          console.log(`   Near-misses (keyword found with spaces removed): ${nearMisses.map(k => `"${k}"`).join(', ')}`);
        }
      }

      // Disqualifier check
      const BASE_DISQUALIFIERS = ['fake news', 'breaking news', 'fyi', 'just sharing', 'rant', 'opinion ko lang', 'just my opinion'];
      const allDisqualifiers = [...BASE_DISQUALIFIERS, ...disqualifiers];
      const matchedDQ = allDisqualifiers.filter(d => lower.includes(d));
      if (matchedDQ.length) {
        console.log(`\n🚫 DISQUALIFIER HIT: ${matchedDQ.map(d => `"${d}"`).join(', ')}`);
      }

      // Signal phrase check
      const matchedSignals = signalPhrases.filter(p => lower.includes(p));
      if (matchedSignals.length) {
        console.log(`\n✅ SIGNAL PHRASE MATCH: ${matchedSignals.map(p => `"${p}"`).join(', ')}`);
      } else if (matchedKeywords.length) {
        console.log(`\n❌ NO SIGNAL PHRASE — post would be skipped unless comment/like threshold is met`);
      }

      // Length check
      if (text.length < 40) {
        console.log(`\n⚠️  TOO SHORT (${text.length} chars, minimum is 40)`);
      }

      // Verdict
      console.log('');
      if (text.length >= 40 && matchedKeywords.length && !matchedDQ.length && matchedSignals.length) {
        console.log('VERDICT: ✅ This post WOULD be captured as a lead (Path D — normal signal)');
      } else if (text.length >= 40 && matchedKeywords.length && !matchedDQ.length) {
        console.log('VERDICT: ⚠️  Keyword matched but no signal phrase — only captured if comments ≥ threshold, likes ≥ threshold, or competitor signal in comments');
      } else if (!matchedKeywords.length) {
        console.log('VERDICT: ❌ Would be skipped — no keyword matched');
      } else if (matchedDQ.length) {
        console.log('VERDICT: ❌ Would be skipped — disqualifier matched');
      }

      console.log('');
      ask();
    }
  }

  ask();
}

main();
