'use strict';

// Random int between min and max (inclusive)
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Extract numeric post ID from a Facebook post URL
function extractPostId(url) {
  // Format: /groups/name/posts/123456
  let m = url.match(/\/posts\/(\d+)/);
  if (m) return m[1];
  // Format: story_fbid=123456
  m = url.match(/story_fbid=(\d+)/);
  if (m) return m[1];
  // Format: ?fbid=123456
  m = url.match(/fbid=(\d+)/);
  if (m) return m[1];
  return null;
}

// Derive a readable group name from the URL
function groupNameFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    // /groups/group-name → 'group-name'
    const idx = parts.indexOf('groups');
    if (idx !== -1 && parts[idx + 1]) {
      return parts[idx + 1].replace(/-/g, ' ');
    }
    return url;
  } catch {
    return url;
  }
}

// Recursively search any object for a numeric field by name.
// Used to find creation_time / reaction counts regardless of nesting depth.
function findDeep(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 20) return undefined;
  if (key in obj && (typeof obj[key] === 'number' || typeof obj[key] === 'string')) return obj[key];
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const v = findDeep(item, key, depth + 1);
      if (v !== undefined) return v;
    }
    return undefined;
  }
  for (const val of Object.values(obj)) {
    const v = findDeep(val, key, depth + 1);
    if (v !== undefined) return v;
  }
  return undefined;
}

// Walk a GraphQL response object recursively, extracting Facebook Story objects.
// Facebook represents feed posts as __typename === 'Story' in its internal GraphQL.
// We collect any Story that has both text content and a URL.
function extractPostsFromGraphQL(obj, results, seenIds, debug, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 20) return;
  if (Array.isArray(obj)) {
    for (const item of obj) extractPostsFromGraphQL(item, results, seenIds, debug, depth + 1);
    return;
  }

  if (obj.__typename === 'Story') {
    const id = String(obj.id || obj.post_id || '');
    if (id && !seenIds.has(id)) {
      seenIds.add(id);

      // Text — try every known path
      let text = '';
      if (obj.message?.text) text = obj.message.text;
      else if (obj.comet_sections?.content?.story?.message?.text)
        text = obj.comet_sections.content.story.message.text;
      else if (obj.body?.text) text = obj.body.text;
      else if (typeof obj.message === 'string') text = obj.message;

      // URL — top-level permalink_url is reliable on feed units
      let url = (obj.permalink_url || obj.url || '').split('?')[0];

      // Timestamp — search comet_sections.timestamp first. If that section exists but has
      // no creation_time, return null rather than falling back to a full Story search.
      // The full-object fallback risks picking up creation_time from nested linked articles
      // or shared posts whose dates can be months older than the actual post.
      const tsSection = obj.comet_sections?.timestamp ?? null;
      const rawTime = tsSection
        ? findDeep(tsSection, 'creation_time')
        : findDeep(obj, 'creation_time');
      const postedAt = (typeof rawTime === 'number' && rawTime > 0)
        ? new Date(rawTime * 1000).toISOString()
        : null;

      // Engagement — search recursively since feedback nesting varies
      const commentCount = Number(findDeep(obj, 'total_count') ?? 0);
      const likeCount = Number(
        findDeep(obj.comet_sections?.feedback ?? obj.feedback ?? obj, 'count') ?? 0
      );

      if (debug && text && url) {
        console.log(`[scraper] GraphQL story: id=${id} rawTime=${rawTime} comments=${commentCount} likes=${likeCount} postedAt=${postedAt} text="${text.slice(0, 60)}..."`);
      }

      if (text && text.length > 10 && url) {
        results.push({ id, text: text.slice(0, 1000), url, postedAt, commentCount, likeCount });
      }
    }
  }

  // Recurse into all values — Facebook nests stories inside edges, nodes, and sections
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      extractPostsFromGraphQL(val, results, seenIds, debug, depth + 1);
    }
  }
}

async function scrapeGroup(page, groupUrl, { scrollPasses = 5 } = {}) {
  const groupName = groupNameFromUrl(groupUrl);
  const debugScraper = process.env.DEBUG_SCRAPER === '1';
  console.log(`[scraper] Navigating to: ${groupUrl}`);

  // sk=wall forces the feed tab; RECENT_ACTIVITY shows posts with any recent
  // engagement rather than Facebook's "Most relevant" algorithm
  let targetUrl = groupUrl;
  try {
    const u = new URL(groupUrl);
    u.searchParams.set('sk', 'wall');
    u.searchParams.set('sorting_setting', 'CHRONOLOGICAL');
    targetUrl = u.toString();
  } catch (_) {}

  // ── GraphQL interception — set up BEFORE navigation so we catch all responses ──
  // Collects raw response text from every /api/graphql/ call the page makes
  // (feed load, scroll pagination, etc.). Processed after scrolling completes.
  const rawGraphqlTexts = [];
  const graphqlHandler = async (response) => {
    if (!response.url().includes('/api/graphql/')) return;
    if (response.status() !== 200) return;
    try {
      rawGraphqlTexts.push(await response.text());
    } catch (_) {}
  };
  page.on('response', graphqlHandler);

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    page.off('response', graphqlHandler);
    throw new Error(`[scraper] Navigation failed for ${groupUrl}: ${err.message}`);
  }

  const url = page.url();

  // Checkpoint / login redirect checks
  if (url.includes('/checkpoint')) {
    page.off('response', graphqlHandler);
    throw new Error('CHECKPOINT_DETECTED');
  }
  if (url.includes('/login')) {
    page.off('response', graphqlHandler);
    throw new Error('LOGIN_REDIRECT');
  }

  // Wait for the real feed container first — [role="article"] fires immediately
  // (compose box) and doesn't mean posts have loaded
  const hasFeed = await page.waitForSelector('[role="feed"]', { timeout: 20000 }).then(() => true).catch(() => false);

  if (!hasFeed) {
    // Fallback: check for any article as a last resort
    const hasArticle = await page.waitForSelector('[role="article"]', { timeout: 5000 }).then(() => true).catch(() => false);
    if (!hasArticle) {
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 400));
      const bodyLower = bodyText.toLowerCase();
      if (/join group|request to join|you need to join|sumali|mag-join/.test(bodyLower)) {
        page.off('response', graphqlHandler);
        console.warn(`[scraper] Not a member of ${groupUrl} — skipping`);
        throw new Error('NOT_JOINED');
      }
      page.off('response', graphqlHandler);
      console.warn(`[scraper] Feed not found for ${groupUrl} — body: ${bodyText.replace(/\n/g, ' ')}`);
      return [];
    }
  }

  // Give Facebook extra time to render the first posts into the feed
  await page.waitForTimeout(3000);

  // Scroll — triggers GraphQL pagination requests captured by the handler above
  for (let i = 0; i < scrollPasses; i++) {
    await page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement;
      el.scrollTop += window.innerHeight * 3;
    });
    await page.waitForTimeout(randInt(3000, 5000));
  }

  // Wait for at least one post link to appear after scrolling
  await page.waitForSelector('a[href*="/posts/"]', { timeout: 10000 }).catch(() => {});

  // Expand all "See more" truncations so we get full post text
  try {
    const seeMoreLinks = await page.$$('div[role="button"]:has-text("See more"), span[role="button"]:has-text("See more")');
    for (const el of seeMoreLinks) {
      await el.click().catch(() => {});
      await page.waitForTimeout(200);
    }
    if (seeMoreLinks.length) {
      console.log(`[scraper] Expanded ${seeMoreLinks.length} "See more" links`);
      await page.waitForTimeout(1000);
    }
  } catch (_) { /* non-fatal */ }

  // ── DOM extraction ────────────────────────────────────────────────────────────
  const { posts: rawPosts, totalArticles, skippedCount, sampleSkippedUrls } = await page.evaluate((debug) => {
    const results = [];
    const seenIds = new Set();
    const sampleSkipped = [];

    // Facebook marks each post as role="article"
    const articles = Array.from(document.querySelectorAll('[role="article"]'));
    let skipped = 0;

    for (const article of articles) {
      // Find the post permalink — try all URL patterns Facebook uses
      const allLinks = Array.from(article.querySelectorAll('a[href]'));
      const postLink = allLinks.find(a => {
        const h = a.href || '';
        return /\/posts\/\d+/.test(h)
          || /story_fbid=\d+/.test(h)
          || /\/permalink\/\d+/.test(h)
          || /[?&]fbid=\d+/.test(h);
      });

      if (!postLink) {
        skipped++;
        if (debug && sampleSkipped.length < 5) {
          sampleSkipped.push({
            links: allLinks.slice(0, 5).map(a => a.href).filter(Boolean),
            text: (article.innerText || '').slice(0, 120).replace(/\n+/g, ' '),
          });
        }
        continue;
      }

      const href = postLink.href;
      let postId = null;
      let m;
      if ((m = href.match(/\/posts\/(\d+)/)))      postId = m[1];
      else if ((m = href.match(/\/permalink\/(\d+)/))) postId = m[1];
      else if ((m = href.match(/story_fbid=(\d+)/)))   postId = m[1];
      else if ((m = href.match(/[?&]fbid=(\d+)/)))     postId = m[1];
      if (!postId || seenIds.has(postId)) continue;
      seenIds.add(postId);

      // Extract post text — try multiple strategies, pick the best
      let text = '';

      // Strategy 1: explicit message div
      const msgEl = article.querySelector('[data-ad-preview="message"]');
      if (msgEl) {
        text = (msgEl.innerText || '').trim();
      }

      // Strategy 2: pick the first [dir="auto"] block with enough text.
      // Post body always precedes comment previews in DOM order, so first beats longest.
      if (!text || text.length < 30) {
        const dirAutos = Array.from(article.querySelectorAll('[dir="auto"]'));
        const first = dirAutos
          .map(el => (el.innerText || '').trim())
          .find(t => t.length > 30);
        if (first) text = first;
      }

      if (!text || text.length < 30) continue;

      // The post permalink link's innerText IS Facebook's timestamp label
      const postedAt = (postLink.innerText || '').trim() || null;

      // Extract comment and like/reaction counts (visible on feed without clicking)
      let commentCount = 0;
      let likeCount = 0;
      const allSpans = Array.from(article.querySelectorAll('span'));
      for (const span of allSpans) {
        const t = (span.innerText || '').trim();
        if (!commentCount) {
          const cm = t.match(/^(\d+)\s*(comment|komento)/i);
          if (cm) commentCount = parseInt(cm[1]);
        }
        if (!likeCount) {
          const lm = t.match(/^(\d+)\s*(reaction|people reacted)/i);
          if (lm) likeCount = parseInt(lm[1]);
        }
      }
      if (!likeCount) {
        for (const span of allSpans) {
          const t = (span.innerText || '').trim();
          if (/^\d+$/.test(t) && parseInt(t) > 0) {
            const parent = (span.parentElement?.innerText || '').toLowerCase();
            if (/like|react|love|👍|❤/.test(parent)) {
              likeCount = parseInt(t);
              break;
            }
          }
        }
      }

      const cleanUrl = href.split('?')[0];
      results.push({ id: postId, url: cleanUrl, text: text.slice(0, 1000), postedAt, commentCount, likeCount });
    }

    return { posts: results, totalArticles: articles.length, skippedCount: skipped, sampleSkippedUrls: sampleSkipped };
  }, debugScraper);

  // ── Remove GraphQL interceptor and process captured responses ─────────────────
  page.off('response', graphqlHandler);

  const graphqlPosts = [];
  const graphqlSeenIds = new Set();
  for (const text of rawGraphqlTexts) {
    for (const line of text.trim().split('\n')) {
      if (!line.trim()) continue;
      try {
        extractPostsFromGraphQL(JSON.parse(line), graphqlPosts, graphqlSeenIds, debugScraper);
      } catch (_) {}
    }
  }

  if (debugScraper) {
    console.log(`[scraper] GraphQL: ${rawGraphqlTexts.length} responses intercepted, ${graphqlPosts.length} stories found`);
  }

  // ── Merge DOM + GraphQL results, DOM takes priority (richer context) ──────────
  console.log(`[scraper] DOM: ${rawPosts.length} posts from ${groupName} (${totalArticles} articles, ${skippedCount} skipped)`);
  if (debugScraper && sampleSkippedUrls.length) {
    console.log('[scraper] Skipped article details:');
    sampleSkippedUrls.forEach((item, i) => {
      console.log(`  [${i}] text: "${item.text}"`);
      console.log(`       links: ${item.links.length ? item.links.join(' | ') : '(none)'}`);
    });
  }

  const domIds  = new Set(rawPosts.map(p => p.id));
  const domUrls = new Set(rawPosts.map(p => p.url).filter(Boolean));
  // Filter by both ID and URL — DOM posts have numeric IDs while GraphQL posts
  // have base64 IDs, so the same Facebook post would never match on ID alone.
  const graphqlOnly = graphqlPosts.filter(p => !domIds.has(p.id) && !domUrls.has(p.url));
  const mergedPosts = [...rawPosts, ...graphqlOnly];

  if (graphqlOnly.length > 0) {
    console.log(`[scraper] GraphQL added ${graphqlOnly.length} post(s) not found in DOM`);
  }

  if (debugScraper && mergedPosts.length === 0) {
    const bodySnippet = await page.evaluate(() => document.body.innerText.slice(0, 2000).replace(/\n+/g, ' '));
    const postLinkCount = await page.evaluate(() => document.querySelectorAll('a[href*="/posts/"]').length);
    console.log(`[scraper] Post links on page: ${postLinkCount}`);
    console.log(`[scraper] Page body snapshot: ${bodySnippet}`);
  }

  // Secondary not-joined check
  if (mergedPosts.length === 0 && totalArticles < 5) {
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 600));
    const bodyLower = bodyText.toLowerCase();
    if (/join group|request to join|you need to join|sumali|mag-join|private group|secret group/.test(bodyLower)) {
      console.warn(`[scraper] Not a member of ${groupUrl} — skipping`);
      throw new Error('NOT_JOINED');
    }
  }

  // DOM fallback — scan whole page for post permalink links when article extraction fails
  if (mergedPosts.length === 0) {
    console.log(`[scraper] Trying DOM fallback extraction for ${groupName}`);
    const fallbackPosts = await page.evaluate(() => {
      const results = [];
      const seenIds = new Set();

      const allAnchors = Array.from(document.querySelectorAll('a[href]'));
      const postAnchors = allAnchors.filter(a => {
        const h = a.href || '';
        return (/\/posts\/\d+/.test(h) || /story_fbid=\d+/.test(h) || /\/permalink\/\d+/.test(h))
          && !h.includes('#');
      });

      for (const anchor of postAnchors) {
        const href = anchor.href;
        let postId = null;
        let m;
        if ((m = href.match(/\/posts\/(\d+)/)))          postId = m[1];
        else if ((m = href.match(/\/permalink\/(\d+)/))) postId = m[1];
        else if ((m = href.match(/story_fbid=(\d+)/)))   postId = m[1];
        if (!postId || seenIds.has(postId)) continue;
        seenIds.add(postId);

        let node = anchor;
        let text = '';
        let commentCount = 0;
        let likeCount = 0;
        for (let depth = 0; depth < 12; depth++) {
          node = node.parentElement;
          if (!node) break;
          const dirAutos = Array.from(node.querySelectorAll('[dir="auto"]'));
          const blocks = dirAutos
            .filter(el => el.querySelectorAll('a').length === 0)
            .map(el => (el.innerText || '').replace(/…\s*See more\s*$/i, '').trim())
            .filter(t => t.length > 10)
            .sort((a, b) => b.length - a.length);
          if (blocks.length > 0) {
            text = blocks[0];
            const spans = Array.from(node.querySelectorAll('span'));
            for (const span of spans) {
              const t = (span.innerText || '').trim();
              if (!commentCount) {
                const cm = t.match(/^(\d+)\s*(comment|komento)/i);
                if (cm) commentCount = parseInt(cm[1]);
              }
              if (!likeCount) {
                const lm = t.match(/^(\d+)\s*(reaction|people reacted)/i);
                if (lm) likeCount = parseInt(lm[1]);
              }
            }
            break;
          }
        }

        if (!text) continue;
        const cleanUrl = href.split('?')[0];
        const postedAt = (anchor.innerText || '').trim() || null;
        results.push({ id: postId, url: cleanUrl, text: text.slice(0, 1000), postedAt, commentCount, likeCount });
      }

      return results;
    });

    if (fallbackPosts.length > 0) {
      console.log(`[scraper] DOM fallback found ${fallbackPosts.length} posts from ${groupName}`);
      return fallbackPosts.map(p => ({ ...p, groupName }));
    }
  }

  return mergedPosts.map(p => ({ ...p, groupName }));
}

// Navigate to an individual post, read its comments, and return all comment text
// combined as a single string. Called after scrapeGroup so the page is free to navigate.
// The dwell time on each post also makes run behaviour more human-like.
async function scrapeComments(page, postUrl) {
  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Simulate reading the post before scrolling to comments
    await page.waitForTimeout(randInt(3000, 6000));

    // Scroll down once to reveal comments
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(randInt(1000, 2000));

    const texts = await page.evaluate(() => {
      const articles = Array.from(document.querySelectorAll('[role="article"]'));
      // First article is the post itself — comments follow
      return articles.slice(1).map(el => {
        const msgEl = el.querySelector('[data-ad-preview="message"]');
        if (msgEl) return (msgEl.innerText || '').trim();
        const divs = Array.from(el.querySelectorAll('[dir="auto"]'));
        const longest = divs
          .map(d => (d.innerText || '').trim())
          .filter(t => t.length > 5)
          .sort((a, b) => b.length - a.length)[0];
        return longest || '';
      }).filter(t => t.length > 0);
    });

    const combined = texts.join(' ');
    console.log(`[scraper] Read ${texts.length} comment(s) from post`);
    return combined;
  } catch (err) {
    console.warn(`[scraper] scrapeComments failed for ${postUrl}: ${err.message}`);
    return '';
  }
}

module.exports = { scrapeGroup, scrapeComments };
