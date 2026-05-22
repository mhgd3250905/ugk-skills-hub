#!/usr/bin/env node

import process from 'node:process';

import {
  buildTikTokSearchUrl,
  formatTikTokSearchResult,
} from './tiktok_search_lib.mjs';
import {
  ensureHostBrowserBridge,
  requestHostBrowser,
} from '../../web-access/scripts/host-bridge.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const args = {
    keyword: '',
    days: 30,
    maxScrolls: 30,
    maxResults: 20,
    noNewThreshold: 6,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--keyword') {
      args.keyword = String(argv[index + 1] || '');
      index += 1;
      continue;
    }
    if (token === '--days') {
      args.days = Number(argv[index + 1] || '30');
      index += 1;
      continue;
    }
    if (token === '--max-scrolls') {
      args.maxScrolls = Number(argv[index + 1] || '20');
      index += 1;
      continue;
    }
    if (token === '--max-results') {
      args.maxResults = Number(argv[index + 1] || '20');
      index += 1;
      continue;
    }
    if (token === '--no-new-threshold') {
      args.noNewThreshold = Number(argv[index + 1] || '6');
      index += 1;
      continue;
    }
    if (token === '--dry-run') {
      args.dryRun = true;
    }
  }

  if (!args.keyword.trim()) {
    throw new Error('关键词不能为空');
  }
  if (!Number.isInteger(args.days) || args.days <= 0) {
    throw new Error('days 必须是正整数');
  }
  return args;
}

function toExpression(factory, ...args) {
  return `(${factory.toString()})(${args
    .map((arg) => JSON.stringify(arg))
    .join(',')})`;
}

async function browserCommand(command, meta) {
  const result = await requestHostBrowser(command, {
    timeoutMs: 45000,
    meta,
  });
  if (!result?.ok) {
    throw new Error(result?.error || `browser_command_failed:${command.action}`);
  }
  return result;
}

async function createTarget(url, meta) {
  const result = await browserCommand({ action: 'new_target', url }, meta);
  const targetId = result?.target?.id;
  if (!targetId) {
    throw new Error('browser_target_missing');
  }
  return targetId;
}

async function evaluate(targetId, expression, meta) {
  const result = await browserCommand(
    { action: 'evaluate', targetId, expression },
    meta,
  );
  return result?.value;
}

async function scrollToY(targetId, y, meta) {
  await browserCommand({ action: 'scroll', targetId, y }, meta);
}

async function getWindowHeight(targetId, meta) {
  return await evaluate(targetId, 'window.innerHeight', meta);
}

async function closeTarget(targetId, meta) {
  await browserCommand({ action: 'close_target', targetId }, meta);
}

async function reloadTarget(targetId, url, meta) {
  await browserCommand({ action: 'navigate', targetId, url }, meta);
  await sleep(3000);
}

/**
 * Click any TikTok retry/refresh/failure-recovery buttons on the page.
 * TikTok sometimes shows "重试" / "Retry" / "Refresh" / "Something went wrong" 
 * buttons when lazy-loading fails. If not clicked, the DOM stays stuck.
 * Returns number of buttons clicked.
 */
function clickRetryButtons() {
  let clicked = 0;
  // Strategy 1: Look for buttons/divs with retry/refresh text
  const retryPatterns = /重试|retry|refresh|重新加载|再试一次|try again|something went wrong|加载失败/i;
  const candidates = document.querySelectorAll('button, [role="button"], div[class*="error"], div[class*="retry"], div[class*="fail"]');
  for (const el of candidates) {
    const text = (el.textContent || '').trim();
    if (retryPatterns.test(text) && text.length < 50) {
      try {
        el.scrollIntoView({ block: 'center' });
        el.click();
        clicked += 1;
      } catch (_) { /* skip unclickable elements */ }
    }
  }
  // Strategy 2: Look for error overlay close/dismiss buttons
  if (clicked === 0) {
    const closeButtons = document.querySelectorAll('[aria-label*="close" i], [aria-label*="关闭"], [aria-label*="dismiss" i]');
    for (const btn of closeButtons) {
      // Only click if inside an error/retry container
      const parent = btn.closest('[class*="error"], [class*="retry"], [class*="fail"], [class*="modal"]');
      if (parent) {
        try { btn.click(); clicked += 1; } catch (_) {}
      }
    }
  }
  return clicked;
}

/**
 * Extract video info from TikTok search DOM.
 * Primary data source: <img alt="..."> which contains full desc + hashtags + "created by X".
 */
function collectVisibleVideos() {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  /**
   * Parse date tag → epoch seconds.
   * TikTok uses three formats depending on recency:
   *   - "Xd ago" / "Xh ago" / "Xw ago" for very recent
   *   - "M-D"        for current year
   *   - "YYYY-M-D"   for previous years
   */
  function parseDateTag(text) {
    const trimmed = normalize(text).toLowerCase().replace(/\s+/g, '');

    // Relative time: "1w ago", "3d ago", "14h ago", "2mo ago", "1y ago"
    const relMatch = trimmed.match(/^(\d+)(y|mo|w|d|h|m)ago$/);
    if (relMatch) {
      const num = Number(relMatch[1]);
      const unit = relMatch[2];
      const nowSec = Math.floor(Date.now() / 1000);
      switch (unit) {
        case 'y': return nowSec - num * 31536000;
        case 'mo': return nowSec - num * 2592000;
        case 'w': return nowSec - num * 604800;
        case 'd': return nowSec - num * 86400;
        case 'h': return nowSec - num * 3600;
        case 'm': return nowSec - num * 60;
        default: return 0;
      }
    }

    // Full date: YYYY-M-D
    let match = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
      const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      if (!Number.isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
    }
    // Short date: M-D (assume current year)
    match = trimmed.match(/^(\d{1,2})-(\d{1,2})$/);
    if (match) {
      const now = new Date();
      const month = Number(match[1]) - 1;
      const day = Number(match[2]);
      let year = now.getFullYear();
      const d = new Date(year, month, day);
      if (d > now) { year -= 1; d.setFullYear(year); }
      if (!Number.isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
    }
    return 0;
  }

  const rows = [];
  const seen = new Set();

  const cards = document.querySelectorAll('[data-e2e="search_top-item"]');

  for (const card of cards) {
    // Video URL
    const linkEl = card.querySelector('a[href*="/video/"]');
    const href = normalize(linkEl?.getAttribute('href') || '');
    if (!href) continue;
    let url = '';
    try { url = new URL(href, location.origin).toString(); } catch { continue; }
    if (!/\/video\/\d+/.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    // Author from URL: extract @username from /@username/video/...
    let urlAuthor = '';
    // href may be absolute (https://tiktok.com/@user/video/id) or relative (/@user/video/id)
    const authorMatch = href.match(/\/@?([^/]+)\/video\//);
    if (authorMatch) urlAuthor = authorMatch[1];

    // Primary text source: img alt attribute
    const imgEl = card.querySelector('img[alt]');
    const altText = normalize(imgEl?.getAttribute('alt') || '');

    // Parse desc from alt: remove "created by X ..." or "- medtrum" suffix patterns
    let desc = altText;
    // Various "created by" patterns TikTok uses in alt text
    const createdByIdx =
      altText.search(/\bcreated by\b/i) >= 0 ? altText.search(/\bcreated by\b/i)
      : altText.search(/\b-\s*medtrum\b/i) >= 0 ? altText.search(/\b-\s*medtrum\b/i)
      : -1;
    if (createdByIdx >= 0) {
      desc = altText.slice(0, createdByIdx).trim();
    }

    // Extract hashtags from alt/desc
    const hashMatch = desc.match(/#\S+/g);
    const hashtags = hashMatch ? hashMatch.map((h) => h.replace(/^#/, '')) : [];
    const descClean = desc.replace(/#\S+/g, '').replace(/\s+/g, ' ').trim();
    // If desc is all hashtags (descClean empty), use trimmed alt with hashtags stripped from the suffix
    const finalDesc = descClean || (createdByIdx >= 0 ? altText.replace(/#\S+/g, '').replace(/\s+/g, ' ').trim() : altText);

    // Time: extract from sibling search-card-desc -> DivTimeTag (format YYYY-M-D)
    const container = card.parentElement;
    let createTime = 0;
    if (container) {
      const descCard = container.querySelector('[data-e2e="search-card-desc"]');
      if (descCard) {
        const timeTag = descCard.querySelector('[class*="DivTimeTag"]');
        if (timeTag) {
          const timeText = normalize(timeTag.textContent || '');
          createTime = parseDateTag(timeText);
        }
      }
    }

    // Like count: look for <strong> within this card only
    let statCount = 0;
    const cardStrongs = card.querySelectorAll('strong');
    for (const el of cardStrongs) {
      const t = normalize(el.textContent || '');
      const m = t.match(/^([\d.]+)\s*([kKmM]?)$/);
      if (m) {
        const n = parseFloat(m[1]);
        if (!Number.isNaN(n)) {
          const v = m[2].toLowerCase() === 'k' ? Math.round(n * 1000)
                  : m[2].toLowerCase() === 'm' ? Math.round(n * 1000000)
                  : Math.round(n);
          if (v > statCount) statCount = v;
        }
      }
    }

    rows.push({
      url,
      author: urlAuthor,
      desc: finalDesc,
      hashtags,
      createTime,
      likeCount: statCount,
    });
  }

  return rows;
}

async function collectVideos(targetId, maxScrolls, noNewThreshold, meta) {
  const rows = [];
  const seen = new Set();

  // TikTok's actual scroll container is <main id="grid-main">
  const getScrollInfo = await evaluate(targetId,
    `(function(){
      const grid = document.querySelector('#grid-main');
      return grid ? { clientH: grid.clientHeight, scrollH: grid.scrollHeight } : { clientH: window.innerHeight, scrollH: document.body.scrollHeight };
    })()`,
    meta);

  const containerClientH = getScrollInfo?.clientH || 659;
  const scrollDeltaPerRound = Math.floor(containerClientH * 0.6);
  const smoothChunks = 5;
  const chunkDelayMs = 200;
  let prevScrollH = getScrollInfo?.scrollH || 0;
  let noNewCount = 0;
  let actualScrolls = 0;
  let stoppedReason = 'max_scrolls';

  // Initial retry check: TikTok page sometimes loads with a failure state
  const initRetries = await evaluate(
    targetId,
    toExpression(clickRetryButtons),
    meta,
  ) || 0;
  if (initRetries > 0) {
    console.error(`  [retry] initial: clicked ${initRetries} retry button(s), waiting...`);
    await sleep(3000);
  }

  for (let step = 0; step < maxScrolls; step += 1) {
    actualScrolls = step + 1;

    // Click any retry/refresh buttons before scrolling (TikTok lazy-load failures)
    const retriesClicked = await evaluate(
      targetId,
      toExpression(clickRetryButtons),
      meta,
    ) || 0;
    if (retriesClicked > 0) {
      console.error(`  [retry] clicked ${retriesClicked} retry button(s), waiting for recovery...`);
      await sleep(2000);
    }

    // Scroll #grid-main down in small chunks (instant, no smooth)
    for (let c = 0; c < smoothChunks; c++) {
      await evaluate(targetId,
        `(function(){
          var grid = document.getElementById('grid-main');
          if (grid) grid.scrollTop += ${Math.ceil(scrollDeltaPerRound / smoothChunks)};
          else window.scrollBy(0, ${Math.ceil(scrollDeltaPerRound / smoothChunks)});
        })()`,
        meta);
      await sleep(chunkDelayMs);
    }

    // Wait for TikTok to lazy-load
    await sleep(3000);

    // Check scroll container growth
    const info = await evaluate(targetId,
      `(function(){
        var grid = document.getElementById('grid-main');
        return grid ? { scrollH: grid.scrollHeight, scrollTop: grid.scrollTop } : { scrollH: document.body.scrollHeight, scrollTop: window.scrollY };
      })()`,
      meta);
    const newScrollH = info?.scrollH || 0;
    const scrollTop = info?.scrollTop || 0;

    if (newScrollH === prevScrollH) {
      noNewCount += 1;
    } else {
      prevScrollH = newScrollH;
      noNewCount = 0;
    }

    const currentRows =
      (await evaluate(targetId, toExpression(collectVisibleVideos), meta)) || [];

    let newCount = 0;
    for (const row of currentRows) {
      const url = String(row?.url || '').trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      rows.push(row);
      newCount += 1;
    }

    if (newCount === 0 && noNewCount >= noNewThreshold) {
      // Even if no new content, try one more retry click before giving up
      const lastRetry = await evaluate(
        targetId,
        toExpression(clickRetryButtons),
        meta,
      ) || 0;
      if (lastRetry > 0) {
        console.error(`  [retry] clicked ${lastRetry} retry button(s) as last resort, reset counter`);
        noNewCount = 0;
        await sleep(3000);
        continue;
      }
      stoppedReason = 'no_new_content';
      break;
    }

    if (newCount > 0) {
      noNewCount = 0;
    } else if (retriesClicked > 0) {
      // Retry was clicked but no new content yet — don't count this round as stale
      noNewCount = Math.max(0, noNewCount - 1);
    }

    console.error(`  [scroll ${actualScrolls}/${maxScrolls}] collected=${rows.length} new=${newCount} scrollH=${newScrollH} scrollTop=${scrollTop}`);
  }

  return { rows, scrollStatus: { actualScrolls, maxScrolls, stoppedReason } };
}

/**
 * Client-side filtering matching the criteria previously in the lib.
 * Keeps results where all keyword words appear in desc/hashtags/author
 * and createTime is within days (or createTime is 0 = unknown, include anyway).
 */
function filterResults(rows, keyword, days) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const normalize = (v) => String(v || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const nk = normalize(keyword);
  const kwWords = nk.split(/\s+/).filter(Boolean);
  const cutoffMs = Date.now() - days * DAY_MS;

  const seen = new Set();
  return rows
    .filter((row) => {
      const text = normalize([row.desc, ...(row.hashtags || []), row.author].join(' '));
      // Multi-word: match each word anywhere; single-word: substring match
      const fullMatch = text.includes(nk);
      const wordMatch = kwWords.length > 1 && kwWords.every((w) => text.includes(w));
      if (!fullMatch && !wordMatch) return false;
      // Date filter: include if unknown (0) or within range
      if (row.createTime && row.createTime * 1000 < cutoffMs) return false;
      return true;
    })
    .filter((row) => {
      const key = row.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const finalUrl = buildTikTokSearchUrl(args.keyword);

  if (args.dryRun) {
    console.log(JSON.stringify({ keyword: args.keyword, days: args.days, url: finalUrl, maxScrolls: args.maxScrolls, maxResults: args.maxResults }, null, 2));
    return;
  }

  await ensureHostBrowserBridge();

  let targetId = null;
  try {
    targetId = await createTarget(finalUrl, {
      stage: 'search-open',
      url: finalUrl,
      query: args.keyword,
      taskKind: 'tiktok-search-latest',
    });

    // Preflight: verify page is healthy, with auto-recovery on transient errors
    const PREFLIGHT_SCRIPT = `(() => {
      const title = document.title || '';
      if (!title || title.includes('429') || title.includes('captcha')) return { ok: false, error: 'BLOCKED', detail: 'TikTok rate-limited or captcha' };
      const grid = document.getElementById('grid-main');
      if (!grid) return { ok: false, error: 'NO_GRID', detail: 'TikTok page structure changed (no #grid-main)' };
      const links = document.querySelectorAll('a[href*="/video/"]');
      if (links.length === 0) return { ok: false, error: 'NO_VIDEOS', detail: 'No video links found on page (grid exists but empty)' };
      return { ok: true, title: title, gridScrollH: grid.scrollHeight, videoLinks: links.length };
    })()`;

    const MAX_RECOVERY_ATTEMPTS = 2;
    let preflight = null;

    for (let attempt = 0; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
      const waitMs = attempt === 0 ? 5000 : 3000;
      await sleep(waitMs);

      preflight = await evaluate(targetId, PREFLIGHT_SCRIPT, {
        stage: 'preflight',
        query: args.keyword,
        attempt: attempt + 1,
      });

      if (preflight?.ok) break;

      // Hard failures: no point recovering
      if (preflight?.error === 'BLOCKED') break;

      if (attempt < MAX_RECOVERY_ATTEMPTS) {
        // Step A: try clicking retry buttons on error page first
        console.error(
          'TIKTOK_PREFLIGHT_RECOVERING:' +
            (preflight?.error || 'unknown') +
            ' attempt=' + (attempt + 1) + '/' + MAX_RECOVERY_ATTEMPTS +
            ' trying retry-buttons first',
        );
        const retryClicked = await evaluate(
          targetId,
          toExpression(clickRetryButtons),
          { stage: 'preflight-retry-buttons', query: args.keyword },
        ) || 0;
        if (retryClicked > 0) {
          console.error('  [preflight] clicked ' + retryClicked + ' retry button(s), waiting...');
          await sleep(4000);
          // Re-check after clicking retry buttons
          const recheck = await evaluate(targetId, PREFLIGHT_SCRIPT, {
            stage: 'preflight-recheck',
            query: args.keyword,
          });
          if (recheck?.ok) {
            preflight = recheck;
            break;
          }
          console.error('  [preflight] retry buttons did not fix, will reload page next');
        }

        // Step B: reload the page
        console.error(
          '  [preflight] reloading page (attempt ' + (attempt + 1) + '/' + MAX_RECOVERY_ATTEMPTS + ')',
        );
        await reloadTarget(targetId, finalUrl, {
          stage: 'search-reload',
          url: finalUrl,
          query: args.keyword,
          taskKind: 'tiktok-search-latest',
        });
      }
    }

    if (!preflight?.ok) {
      console.error(
        'TIKTOK_PREFLIGHT_FAILED:' + (preflight?.error || 'unknown') + ' ' + (preflight?.detail || ''),
      );
      process.exit(2);
    }

    const { rows, scrollStatus } = await collectVideos(targetId, args.maxScrolls, args.noNewThreshold, {
      stage: 'search-fetch',
      url: finalUrl,
      query: args.keyword,
      taskKind: 'tiktok-search-latest',
    });

    const selected = filterResults(rows, args.keyword, args.days);

    const validItems = [];
    let dropped = 0;
    for (const row of selected) {
      const date = row.createTime ? new Date(row.createTime * 1000).toISOString().slice(0, 10) : '';
      const author = String(row.author || '').trim();
      const content = String(row.desc || '').replace(/\s+/g, ' ').trim();
      const url = String(row.url || '').trim();

      if (!date) { dropped++; continue; }
      if (!author) { dropped++; continue; }
      if (!content || content.length < 10) { dropped++; continue; }
      if (url && !url.startsWith('https://www.tiktok.com/')) { dropped++; continue; }

      validItems.push({ date, author, content: content.slice(0, 300), url });
    }

    const result = {
      platform: 'TikTok',
      keyword: args.keyword,
      retrievedAt: new Date().toISOString(),
      queryUrl: finalUrl,
      preflight,
      scrollStatus,
      total: validItems.length,
      dropped,
      items: validItems,
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (targetId) {
      await closeTarget(targetId, {
        stage: 'search-close',
        url: finalUrl,
        query: args.keyword,
        taskKind: 'tiktok-search-latest',
      }).catch(() => undefined);
    }
  }
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.message : 'tiktok_search_latest_failed';
  console.error(`TikTok Latest 查询失败：${message}`);
  process.exitCode = 1;
});
