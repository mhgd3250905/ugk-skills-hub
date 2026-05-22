#!/usr/bin/env node
/**
 * Reddit search runner via browser automation.
 * Used when direct HTTP requests are blocked (403/anti-bot).
 */

import { ensureHostBrowserBridge } from '../../web-access/scripts/host-bridge.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function proxyRequest(endpoint, options = {}) {
  const url = `http://127.0.0.1:3456${endpoint}`;
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function createTarget(url) {
  return proxyRequest(`/new?url=${encodeURIComponent(url)}`);
}

async function evalScript(targetId, expression) {
  return proxyRequest(`/eval?target=${encodeURIComponent(targetId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: expression,
  });
}

async function closeTarget(targetId) {
  return proxyRequest(`/close?target=${encodeURIComponent(targetId)}`);
}

// Extract Reddit search results from DOM (for Reddit's SDUI structure)
const EXTRACT_POSTS_SCRIPT = `
(function() {
  const results = [];
  const containers = document.querySelectorAll('[data-testid="search-sdui-post"], [data-testid="search-post-unit"], [data-testid="sdui-post-unit"]');
  containers.forEach(container => {
    try {
      const titleEl = container.querySelector('[data-testid="post-title-text"]') || container.querySelector('a[href*="/comments/"]');
      const title = titleEl ? titleEl.textContent.trim() : '';
      const linkEl = container.querySelector('a[href*="/comments/"]');
      const href = linkEl ? linkEl.getAttribute('href') : '';
      const permalink = href ? (href.startsWith('/') ? 'https://www.reddit.com' + href.split('?')[0] : href.split('?')[0]) : '';
      if (!permalink || !permalink.includes('/comments/')) return;
      const subMatch = permalink.match(/reddit\\.com\\/r\\/([^\\/]+)/);
      const subreddit = subMatch ? 'r/' + subMatch[1] : 'r/unknown';
      const authorEl = container.querySelector('a[href^="/user/"]');
      let author = authorEl ? authorEl.getAttribute('href').replace('/user/', '').replace('/comments/', '') : '[unknown]';
      const timeEl = container.querySelector('time');
      const datetime = timeEl ? timeEl.getAttribute('datetime') : '';
      const timeText = timeEl ? timeEl.textContent.trim() : '';
      results.push({ datetime, timeText, subreddit, author, title, selftext: '', score: 0, numComments: 0, permalink });
    } catch (e) {}
  });
  // Fallback: scan all comment links
  if (results.length === 0) {
    const allLinks = document.querySelectorAll('a[href*="/comments/"]');
    allLinks.forEach(link => {
      const href = link.getAttribute('href');
      const permalink = href.startsWith('/') ? 'https://www.reddit.com' + href.split('?')[0] : href.split('?')[0];
      if (permalink.includes('/comments/') && !results.find(r => r.permalink === permalink)) {
        const subMatch = permalink.match(/reddit\\.com\\/r\\/([^\\/]+)/);
        results.push({
          datetime: '', timeText: '', subreddit: subMatch ? 'r/' + subMatch[1] : 'r/unknown',
          author: '[unknown]', title: link.textContent.trim().substring(0, 100), selftext: '', score: 0, numComments: 0, permalink
        });
      }
    });
  }
  return JSON.stringify(results);
})();
`;

const SCROLL_SCRIPT = `(function(){
  for (let i = 0; i < 5; i++) {
    window.scrollBy(0, 80);
  }
})();`;

function parseDatetime(datetime, timeText) {
  if (datetime) return datetime;
  if (timeText) {
    const now = new Date();
    const match = timeText.match(/(\d+)\s+(hour|day|week|month|year)s?\s+ago/i);
    if (match) {
      const value = parseInt(match[1], 10);
      const unit = match[2].toLowerCase();
      switch (unit) {
        case 'hour': now.setHours(now.getHours() - value); break;
        case 'day': now.setDate(now.getDate() - value); break;
        case 'week': now.setDate(now.getDate() - value * 7); break;
        case 'month': now.setMonth(now.getMonth() - value); break;
        case 'year': now.setFullYear(now.getFullYear() - value); break;
      }
      return now.toISOString();
    }
  }
  return null;
}

async function main() {
  const keyword = process.argv[2] || '';
  const days = parseInt(process.argv[3], 10) || 30;
  const maxScrolls = parseInt(process.argv[4], 10) || 8;

  if (!keyword) {
    console.error('错误：关键词不能为空');
    process.exit(1);
  }

  const url = `https://www.reddit.com/search/?q=${encodeURIComponent(keyword)}&sort=new&type=link`;

  await ensureHostBrowserBridge();

  console.error('[reddit] Opening...');
  let targetId = null;
  try {
    const created = await createTarget(url);
    targetId = created?.targetId || created?.target?.id;
  } catch (e) {
    console.error('无法创建浏览器 target:', e.message);
    process.exit(1);
  }

  console.error('Target ID:', targetId);
  await sleep(5000);

  // Preflight: verify page is healthy
  const preflightRaw = await evalScript(targetId, `(function(){
    var title = document.title || '';
    if (title.includes('blocked') || title.includes('429')) return JSON.stringify({ ok: false, error: 'BLOCKED', detail: 'Reddit rate-limited' });
    if (!title) return JSON.stringify({ ok: false, error: 'EMPTY_PAGE', detail: 'Page did not load' });
    var posts = document.querySelectorAll('[data-testid="search-sdui-post"], [data-testid="search-post-unit"], [data-testid="sdui-post-unit"]');
    if (posts.length === 0) return JSON.stringify({ ok: false, error: 'NO_RESULTS', detail: 'No search result units found' });
    return JSON.stringify({ ok: true, title, postUnits: posts.length });
  })()`);
  let preflight = { ok: false, error: 'unknown' };
  try { preflight = JSON.parse(preflightRaw); } catch(e) {}
  if (!preflight.ok) {
    console.error('REDDIT_PREFLIGHT_FAILED:' + (preflight.error || 'unknown') + ' ' + (preflight.detail || ''));
    process.exit(2);
  }

  let allPosts = [];
  const seenUrls = new Set();
  let noNewRounds = 0;
  const noNewLimit = 3;

  // Extract posts with smooth scrolling to trigger Reddit's infinite scroll
  for (let i = 0; i < maxScrolls; i++) {
    console.error(`[reddit] round ${i+1}...`);
    try {
      const rawResult = await evalScript(targetId, EXTRACT_POSTS_SCRIPT);
      if (rawResult) {
        try {
          const posts = JSON.parse(rawResult);
          let newCount = 0;
          for (const post of posts) {
            if (post.permalink && !seenUrls.has(post.permalink)) {
              seenUrls.add(post.permalink);
              allPosts.push({ ...post, datetime: parseDatetime(post.datetime, post.timeText) });
              newCount++;
            }
          }
          if (newCount === 0) {
            noNewRounds++;
          } else {
            noNewRounds = 0;
          }
        } catch (e) { /* JSON parse fail, continue */ }
      }
    } catch (e) {
      console.error(`[reddit] extract error: ${e.message}`);
    }
    console.error(`[reddit] ${i + 1}: ${allPosts.length} posts`);

    if (noNewRounds >= noNewLimit) {
      console.error(`[reddit] no new, stopped`);
      break;
    }

    if (i < maxScrolls - 1) {
      // Smooth scroll using pre-defined SCROLL_SCRIPT (function-wrapped)
      try {
        await evalScript(targetId, SCROLL_SCRIPT);
        await sleep(2500);
      } catch (e) {
        // Fallback: try single scrollBy
        try {
          await evalScript(targetId, `(function(){ window.scrollBy(0, 400); })()`);
          await sleep(2500);
        } catch (e2) {
          console.error('[reddit] scroll failed, stopping');
          break;
        }
      }
    }
  }

  // Filter by days
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const filteredPosts = allPosts.filter(post => {
    if (!post.datetime) return true;
    return new Date(post.datetime) >= cutoffDate;
  });

  const validItems = [];
  let dropped = 0;
  for (const post of filteredPosts) {
    const date = post.datetime ? new Date(post.datetime).toISOString().slice(0, 10) : '';
    const author = String(post.author || '').trim();
    const content = String((post.title || '') + (post.selftext ? ' - ' + post.selftext : '')).trim();
    const url = String(post.permalink || '').trim();

    if (!date) { dropped++; continue; }
    if (!content || content.length < 10) { dropped++; continue; }
    if (url && !url.startsWith('https://www.reddit.com/')) { dropped++; continue; }

    validItems.push({ date, author: author || 'unknown', content: content.slice(0, 300), url });
  }

  const result = {
    platform: 'Reddit',
    keyword,
    retrievedAt: new Date().toISOString(),
    queryUrl: url,
    preflight,
    scrollStatus: { allCollected: allPosts.length, filtered: filteredPosts.length },
    total: validItems.length,
    dropped,
    items: validItems,
  };
  console.log(JSON.stringify(result, null, 2));

  try { await closeTarget(targetId); } catch (e) {}
}

main().catch(err => {
  console.error('执行失败:', err.message);
  process.exit(1);
});