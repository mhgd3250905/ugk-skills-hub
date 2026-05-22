#!/usr/bin/env node
/**
 * reddit-data 浏览器通道 — 当 HTTP 被 403 封禁时，通过 Chrome sidecar
 * 用 old.reddit.com 的简单 DOM 提取数据，绕过 IP 级别反爬。
 *
 * 命令行格式与 reddit.py 保持一致，直接输出 JSON 到 stdout。
 */

import { ensureHostBrowserBridge, requestHostBrowser } from '../../web-access/scripts/host-bridge.mjs';

// ── Bridge helpers ──────────────────────────────────────────────
const BRIDGE = 'http://127.0.0.1:3456';

async function bridge(ep, opts = {}) {
  const res = await fetch(`${BRIDGE}${ep}`, {
    signal: AbortSignal.timeout(60000),
    ...opts,
  });
  const t = await res.text();
  try { return JSON.parse(t); } catch { return t; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function createTarget(url) {
  const r = await bridge(`/new?url=${encodeURIComponent(url)}`);
  const targetId = r?.targetId || r?.target?.id;
  if (!targetId) throw new Error('createTarget: no targetId returned');
  return targetId;
}
async function evalJs(targetId, expr) {
  return bridge(`/eval?target=${encodeURIComponent(targetId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: expr,
  });
}
async function closeTarget(targetId) { return bridge(`/close?target=${encodeURIComponent(targetId)}`); }

// ── DOM extraction scripts (old.reddit.com) ────────────────────

// 1. Search results
const EXTRACT_SEARCH = `(function(){
  const results = [];
  document.querySelectorAll('.search-result').forEach(el => {
    try {
      const titleA = el.querySelector('a.search-title');
      const title = titleA ? titleA.textContent.trim() : '';
      const href = titleA ? titleA.getAttribute('href') : '';
      const permalink = href.startsWith('http') ? href.split('?')[0] : (href ? 'https://old.reddit.com' + href.split('?')[0] : '');
      const commentsA = el.querySelector('a.search-comments');
      const commentsHref = commentsA ? commentsA.getAttribute('href') : '';
      const finalLink = permalink || (commentsHref ? 'https://old.reddit.com' + commentsHref.split('?')[0] : '');
      if (!finalLink || !finalLink.includes('/comments/')) return;

      const authorA = el.querySelector('.search-author .author, a.author');
      const author = authorA ? authorA.textContent.trim() : '';
      const subA = el.querySelector('a.search-subreddit-link');
      const subreddit = subA ? subA.textContent.trim() : '';
      const scoreEl = el.querySelector('.search-score');
      const scoreText = scoreEl ? scoreEl.textContent.trim() : '0';
      const score = parseInt(scoreText) || 0;
      const commentsEl = el.querySelector('a.search-comments');
      const commentsText = commentsEl ? commentsEl.textContent.trim() : '0 comments';
      const numComments = parseInt(commentsText) || 0;
      const timeEl = el.querySelector('time');
      const createdUtc = timeEl ? timeEl.getAttribute('datetime') : '';
      const selftextEl = el.querySelector('.search-result-body .md, .search-expando .usertext-body');
      const selftext = selftextEl ? selftextEl.textContent.trim() : '';

      results.push({
        id: (el.getAttribute('data-fullname') || '').replace('t3_', ''),
        name: el.getAttribute('data-fullname') || '',
        title, author, subreddit, score, num_comments: numComments,
        created_utc: createdUtc, selftext, permalink: finalLink,
        link_flair_text: '', over_18: false, spoiler: false, domain: '', url: finalLink
      });
    } catch(e) {}
  });
  if (results.length === 0) {
    // Fallback: scan any links to /comments/
    document.querySelectorAll('a[href*="/comments/"]').forEach(a => {
      const href = a.getAttribute('href');
      if (!href) return;
      const permalink = href.startsWith('http') ? href.split('?')[0] : 'https://old.reddit.com' + href.split('?')[0];
      const title = a.textContent.trim();
      if (!title || title.length < 3) return;
      if (results.find(r => r.permalink === permalink)) return;
      results.push({ id: '', name: '', title, author: '', subreddit: '',
        score: 0, num_comments: 0, created_utc: '', selftext: '', permalink,
        link_flair_text: '', over_18: false, spoiler: false, domain: '', url: permalink });
    });
  }
  return JSON.stringify(results);
})();`;

// 2. Subreddit listing
const EXTRACT_SUBREDDIT = `(function(){
  const posts = [];
  document.querySelectorAll('.thing[data-fullname]').forEach(el => {
    const fullname = el.getAttribute('data-fullname') || '';
    if (!fullname.startsWith('t3_')) return;
    try {
      const scoreEl = el.querySelector('.midcol .score');
      const score = parseInt(scoreEl ? scoreEl.textContent.trim() : '0') || 0;
      const titleA = el.querySelector('a.title');
      const title = titleA ? titleA.textContent.trim() : '';
      const href = titleA ? titleA.getAttribute('href') : '';
      const permalink = href.startsWith('http') ? href.split('?')[0] : (href ? 'https://old.reddit.com' + href.split('?')[0] : '');
      const authorA = el.querySelector('a.author');
      const author = authorA ? authorA.textContent.trim() : '';
      const subredditA = el.querySelector('a.subreddit');
      const subreddit = subredditA ? subredditA.textContent.trim() : '';
      const timeEl = el.querySelector('time');
      const createdUtc = timeEl ? timeEl.getAttribute('datetime') : '';
      const commentsA = el.querySelector('a.comments, .comments');
      const commentsText = commentsA ? commentsA.textContent.trim() : '0';
      const numComments = parseInt(commentsText) || 0;
      const flairEl = el.querySelector('.linkflairlabel');
      const flair = flairEl ? flairEl.textContent.trim() : '';
      const selftextEl = el.querySelector('.expando .usertext-body .md, .expando .md');
      const selftext = selftextEl ? selftextEl.textContent.trim() : '';

      posts.push({
        id: fullname.replace('t3_', ''), name: fullname, title, author, subreddit,
        score, num_comments: numComments, created_utc: createdUtc, selftext, permalink,
        link_flair_text: flair, over_18: false, spoiler: false, domain: '', url: permalink
      });
    } catch(e) {}
  });
  return JSON.stringify(posts);
})();`;

// 3. Post + comments
const EXTRACT_POST = `(function(){
  const result = { post: null, comments: [] };

  function extractComment(el, depth) {
    if (!el || !el.classList.contains('comment')) return null;
    try {
      const fullname = el.getAttribute('data-fullname') || '';
      const authorA = el.querySelector('.tagline a.author');
      const author = authorA ? authorA.textContent.trim() : '';
      const scoreEl = el.querySelector('.tagline .score');
      const scoreText = scoreEl ? scoreEl.textContent.trim() : '0';
      const score = parseInt(scoreText.replace(/[^\\d-]/g, '')) || 0;
      const timeEl = el.querySelector('.tagline time');
      const createdUtc = timeEl ? timeEl.getAttribute('datetime') : '';
      const bodyEl = el.querySelector('.usertext-body .md');
      const body = bodyEl ? bodyEl.innerHTML.trim() : '';
      const isSubmitter = el.querySelector('.submitter') !== null;

      const comment = {
        id: fullname.replace('t1_', ''),
        author, body, score, created_utc: createdUtc,
        is_submitter: isSubmitter, depth: depth || 0, replies: []
      };

      const childEl = el.querySelector('.child');
      if (childEl) {
        const childComments = childEl.querySelectorAll(':scope > .sitetable > .thing.comment');
        childComments.forEach(cc => {
          const nested = extractComment(cc, (depth || 0) + 1);
          if (nested) comment.replies.push(nested);
        });
        const childListing = childEl.querySelector(':scope > .thing.comment');
        if (childListing && comment.replies.length === 0) {
          const nested = extractComment(childListing, (depth || 0) + 1);
          if (nested) comment.replies.push(nested);
        }
      }
      return comment;
    } catch(e) { return null; }
  }

  // Post
  const postEl = document.querySelector('.linklisting .thing[data-fullname]') || document.querySelector('.sitetable.linklisting .thing');
  if (postEl) {
    const fullname = postEl.getAttribute('data-fullname') || '';
    const titleA = postEl.querySelector('a.title');
    const title = titleA ? titleA.textContent.trim() : '';
    const authorA = postEl.querySelector('a.author');
    const author = authorA ? authorA.textContent.trim() : '';
    const subredditA = postEl.querySelector('a.subreddit');
    const subreddit = subredditA ? subredditA.textContent.trim() : '';
    const scoreEl = postEl.querySelector('.midcol .score, .score .number');
    const score = parseInt(scoreEl ? scoreEl.textContent.trim() : '0') || 0;
    const timeEl = postEl.querySelector('time');
    const createdUtc = timeEl ? timeEl.getAttribute('datetime') : '';
    const selftextEl = postEl.querySelector('.expando .usertext-body .md');
    const selftext = selftextEl ? selftextEl.textContent.trim() : '';
    const commentsA = postEl.querySelector('a.comments, .comments');
    const commentsText = commentsA ? commentsA.textContent.trim() : '0';

    result.post = {
      id: fullname.replace('t3_', ''), name: fullname, title, author, subreddit,
      score, num_comments: parseInt(commentsText) || 0,
      created_utc: createdUtc, selftext, permalink: location.href.split('?')[0],
      link_flair_text: '', over_18: false, spoiler: false, domain: '', url: location.href.split('?')[0]
    };
  }

  // Comments
  const commentArea = document.querySelector('.commentarea');
  if (commentArea) {
    const topComments = commentArea.querySelectorAll(':scope > .sitetable > .thing.comment');
    topComments.forEach(el => {
      const c = extractComment(el, 0);
      if (c) result.comments.push(c);
    });
  }

  return JSON.stringify(result);
})();`;

// 4. Subreddit search
const EXTRACT_SUBREDDIT_SEARCH = `(function(){
  const subs = [];
  document.querySelectorAll('.subreddit-result, .search-result-subreddit').forEach(el => {
    try {
      const nameA = el.querySelector('a.search-title, a[href^="/r/"]');
      const name = nameA ? nameA.textContent.replace(/^\\/r\\//, '').trim() : '';
      const titleEl = el.querySelector('.description, .search-description');
      const title = titleEl ? titleEl.textContent.trim() : name;
      const subsEl = el.querySelector('.subscribers, .search-subscribers');
      const subsText = subsEl ? subsEl.textContent.replace(/[^\\d]/g, '') : '0';
      const subscribers = parseInt(subsText) || 0;
      const descEl = el.querySelector('.public-description, .search-public-description');
      const publicDescription = descEl ? descEl.textContent.trim() : '';
      subs.push({ name, title, subscribers, public_description: publicDescription });
    } catch(e) {}
  });
  // Fallback
  if (subs.length === 0) {
    document.querySelectorAll('a[href^="/r/"]').forEach(a => {
      const href = a.getAttribute('href');
      if (!href) return;
      const match = href.match(/^\\/r\\/([^\\/]+)\\/?$/);
      if (!match) return;
      const name = match[1];
      if (subs.find(s => s.name === name)) return;
      const title = a.textContent.trim() || name;
      subs.push({ name, title, subscribers: 0, public_description: '' });
    });
  }
  return JSON.stringify(subs);
})();`;

// 5. Trending subreddits
const EXTRACT_TRENDING = `(function(){
  const subs = [];
  document.querySelectorAll('.subreddit-result, .trending-subreddits .thing, .default-subreddits a[href^="/r/"]').forEach(el => {
    try {
      const nameA = el.querySelector('a[href^="/r/"]') || el;
      const href = nameA.getAttribute('href') || '';
      const match = href.match(/^\\/r\\/([^\\/]+)\\/?$/);
      if (!match) return;
      const name = match[1];
      const titleEl = el.querySelector('.title, .description');
      const title = titleEl ? titleEl.textContent.trim() : name;
      const subsEl = el.querySelector('.subscribers');
      const subsText = subsEl ? subsEl.textContent.replace(/[^\\d]/g, '') : '0';
      const subscribers = parseInt(subsText) || 0;
      subs.push({ name, title, subscribers, public_description: '' });
    } catch(e) {}
  });
  // Fallback
  if (subs.length === 0) {
    document.querySelectorAll('a[href^="/r/"]').forEach(a => {
      const href = a.getAttribute('href');
      if (!href) return;
      const match = href.match(/^\\/r\\/([^\\/]+)\\/?$/);
      if (!match) return;
      const name = match[1];
      if (subs.find(s => s.name === name)) return;
      subs.push({ name, title: name, subscribers: 0, public_description: '' });
    });
  }
  return JSON.stringify(subs);
})();`;

// ── Command handlers ────────────────────────────────────────────

async function doSearch(query, sort, time, limit, subreddit) {
  let url = 'https://old.reddit.com';
  if (subreddit) {
    url += `/r/${subreddit}/search?q=${encodeURIComponent(query)}&sort=${sort}&restrict_sr=on`;
  } else {
    url += `/search?q=${encodeURIComponent(query)}&sort=${sort}`;
  }
  if (time && time !== 'all') url += `&t=${time}`;

  const targetId = await createTarget(url);
  console.error(`[reddit-browser] target: ${targetId}`);
  await sleep(4000);

  // Scroll to load more
  for (let i = 0; i < 5; i++) {
    await evalJs(targetId, `(function(){ window.scrollBy(0, 600); })()`).catch(() => {});
    await sleep(1500);
  }

  const raw = await evalJs(targetId, EXTRACT_SEARCH);
  let posts = [];
  try { posts = JSON.parse(raw); } catch(e) { console.error('[reddit-browser] parse error:', e.message); }

  await closeTarget(targetId).catch(() => {});

  if (limit && posts.length > limit) posts = posts.slice(0, limit);

  console.log(JSON.stringify({
    query, subreddit: subreddit || null, sort, time,
    count: posts.length, after: null, before: null, posts,
  }, null, 2));
}

async function doSubreddit(sub, sort, time, limit) {
  const url = `https://old.reddit.com/r/${sub}/${sort}/`;
  const targetId = await createTarget(url);
  console.error(`[reddit-browser] target: ${targetId}`);
  await sleep(4000);

  for (let i = 0; i < 4; i++) {
    await evalJs(targetId, `(function(){ window.scrollBy(0, 600); })()`).catch(() => {});
    await sleep(1500);
  }

  const raw = await evalJs(targetId, EXTRACT_SUBREDDIT);
  let posts = [];
  try { posts = JSON.parse(raw); } catch(e) { console.error('[reddit-browser] parse error:', e.message); }

  await closeTarget(targetId).catch(() => {});

  if (limit && posts.length > limit) posts = posts.slice(0, limit);

  console.log(JSON.stringify({
    subreddit: sub, sort, time, count: posts.length,
    after: null, before: null, posts,
  }, null, 2));
}

async function doPost(target) {
  let url = target;
  if (!url.startsWith('http')) url = 'https://old.reddit.com' + url;
  url = url.replace('www.reddit.com', 'old.reddit.com');
  if (!url.includes('old.reddit.com')) {
    url = url.replace('reddit.com', 'old.reddit.com');
  }

  const targetId = await createTarget(url);
  console.error(`[reddit-browser] target: ${targetId}`);
  await sleep(4000);

  const raw = await evalJs(targetId, EXTRACT_POST);
  let result = {};
  try { result = JSON.parse(raw); } catch(e) { console.error('[reddit-browser] parse error:', e.message); }

  await closeTarget(targetId).catch(() => {});

  console.log(JSON.stringify(result, null, 2));
}

async function doFindSubreddit(query, limit) {
  const url = `https://old.reddit.com/subreddits/search?q=${encodeURIComponent(query)}`;
  const targetId = await createTarget(url);
  console.error(`[reddit-browser] target: ${targetId}`);
  await sleep(4000);

  const raw = await evalJs(targetId, EXTRACT_SUBREDDIT_SEARCH);
  let subs = [];
  try { subs = JSON.parse(raw); } catch(e) { console.error('[reddit-browser] parse error:', e.message); }

  await closeTarget(targetId).catch(() => {});

  if (limit && subs.length > limit) subs = subs.slice(0, limit);

  console.log(JSON.stringify({
    query, count: subs.length, after: null, subreddits: subs,
  }, null, 2));
}

async function doTrending() {
  const url = 'https://old.reddit.com/subreddits/';
  const targetId = await createTarget(url);
  console.error(`[reddit-browser] target: ${targetId}`);
  await sleep(4000);

  const raw = await evalJs(targetId, EXTRACT_TRENDING);
  let subs = [];
  try { subs = JSON.parse(raw); } catch(e) { console.error('[reddit-browser] parse error:', e.message); }

  await closeTarget(targetId).catch(() => {});

  console.log(JSON.stringify({
    count: subs.length, default_subreddits: subs,
  }, null, 2));
}

// ── CLI ─────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd) { console.error('Usage: reddit-browser.mjs <command> [args...]'); process.exit(1); }

  // Try to connect to browser bridge
  let bridgeOk = false;
  try {
    await ensureHostBrowserBridge();
    // Double-check: can we actually reach the bridge API?
    const testRes = await fetch('http://127.0.0.1:3456/', { signal: AbortSignal.timeout(3000) });
    bridgeOk = testRes.ok || testRes.status < 500;
  } catch (e) {
    // ensureHostBrowserBridge or fetch failed
  }
  if (!bridgeOk) {
    console.error(`[reddit-browser] Browser bridge not available.`);
    console.error('[reddit-browser] This requires a Chrome sidecar (use the web-access skill first).');
    process.exit(1);
  }
  console.error(`[reddit-browser] command: ${cmd}`);

  const rest = args.slice(1);
  // Parse common flags from rest
  let sort = 'new', time = 'all', limit = null, subreddit = null, target = null;

  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--sort') sort = rest[++i];
    else if (rest[i] === '--time') time = rest[++i];
    else if (rest[i] === '--limit') limit = parseInt(rest[++i], 10);
    else if (rest[i] === '--subreddit') subreddit = rest[++i];
    else if (!target && !rest[i].startsWith('--')) target = rest[i];
  }

  switch (cmd) {
    case 'search':
      await doSearch(target || '', sort, time, limit, subreddit);
      break;
    case 'subreddit':
      await doSubreddit(target || '', sort, time, limit);
      break;
    case 'post':
      await doPost(target || '');
      break;
    case 'find-subreddit':
      await doFindSubreddit(target || '', limit);
      break;
    case 'trending':
      await doTrending();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
  }
}

main().catch(err => {
  console.error('Browser channel error:', err.message);
  process.exit(1);
});
