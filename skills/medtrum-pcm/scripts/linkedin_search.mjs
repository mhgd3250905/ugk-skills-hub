#!/usr/bin/env node
// @version 2026-05-19-v3 — linkedin_search spider
// Changelog v3:
//   - Single-phase bottom detection: immediately check button when stuck, no 8-round wait
//   - Button click uses same collectVisiblePosts(60) as normal scroll (was 120)
//   - Unified deadEndCount across button+bounce; 3 dead ends → done
// Changelog v2:
//   - Two-phase bottom detection: 8-round stuck → bounce → 3 bounces → done
//   - Dynamic mode: auto infinite-scroll (wide) or scaffold-finite-scroll button (narrow)
//   - DOM structural selectors only, zero hardcoded UI text
//   - Loading detection: [role="progressbar"], [class*="loader"], [aria-busy]
//   - Tab cleanup: startup stale-tab sweep + SIGTERM/SIGINT graceful close + finally
//   - Container detection: scrollMetrics / scrollAndTryLoadMore / recheck unified
// Verify: grep '@version' linkedin_search.mjs

import fs from 'node:fs';
import process from 'node:process';

import {
  buildLinkedInSearchUrl,
  buildSearchResultJson,
} from './linkedin_search_lib.mjs';
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
    maxScrolls: 50,
    maxResults: 100,
    dryRun: false,
    debugDump: '',
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
      args.maxScrolls = Number(argv[index + 1] || '3');
      index += 1;
      continue;
    }
    if (token === '--max-results') {
      args.maxResults = Number(argv[index + 1] || '12');
      index += 1;
      continue;
    }
    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (token === '--debug-dump') {
      args.debugDump = String(argv[index + 1] || '');
      index += 1;
    }
  }

  if (!args.keyword.trim()) {
    throw new Error('关键词不能为空');
  }
  if (!Number.isInteger(args.days) || args.days <= 0) {
    throw new Error('days 必须是正整数');
  }
  if (!Number.isInteger(args.maxScrolls) || args.maxScrolls <= 0) {
    throw new Error('max-scrolls 必须是正整数');
  }
  if (!Number.isInteger(args.maxResults) || args.maxResults <= 0) {
    throw new Error('max-results 必须是正整数');
  }

  return args;
}

function resolveAgentScope() {
  const candidates = [
    process.env.CLAUDE_AGENT_ID,
    process.env.CLAUDE_HOOK_AGENT_ID,
    process.env.agent_id,
  ];
  for (const value of candidates) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed) return trimmed;
  }
  return '';
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

async function closeTarget(targetId, meta) {
  await browserCommand({ action: 'close_target', targetId }, meta);
}

function toExpression(factory, ...args) {
  return `(${factory.toString()})(${args
    .map((arg) => JSON.stringify(arg))
    .join(',')})`;
}

/**
 * Collect visible posts from the LinkedIn search results page DOM.
 * Extracts URLs with priority: /feed/update/ > internal non-author link
 * (with safety/go decoding) > author profile link as last resort.
 */
function collectVisiblePosts(limit) {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const toAbsoluteUrl = (value) => {
    try {
      return new URL(String(value || ''), location.origin).toString();
    } catch {
      return '';
    }
  };
  const findRelativeTimeLabel = (text) => {
    const patterns = [
      /\d+\s*(?:分钟|分|mins?|minutes?)(?!\S)/i,
      /\d+\s*(?:小时|hrs?|hours?)(?!\S)/i,
      /\d+\s*(?:天|days?)(?!\S)/i,
      /\d+\s*(?:周|weeks?|w)(?!\S)/i,
      /\d+\s*(?:个月|月|months?|mos?)(?!\S)/i,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return normalize(match[0]);
    }
    return '';
  };
  const normalizeAuthorText = (text) => {
    const compact = normalize(text);
    if (!compact) return '';
    return compact
      .split(/\d+\s*(?:分钟|分|mins?|minutes?|小时|hrs?|hours?|天|days?|周|weeks?|w|个月|月|months?|mos?)/i)[0]
      .split('•')[0]
      .trim();
  };
  const pickContainer = (anchor) => {
    // Climb up ancestors to find the post card element.
    // Strategy: find the deepest ancestor whose text length is in the
    // typical post-card range (160–3000 chars). No language-dependent labels.
    let node = anchor;
    let fallback = anchor.parentElement || anchor;
    for (let depth = 0; depth < 8 && node; depth += 1) {
      const text = normalize(node.innerText || node.textContent || '');
      if (text.length >= 40) fallback = node;
      if (text.length >= 160 && text.length <= 3000) {
        return node;
      }
      node = node.parentElement;
    }
    return fallback;
  };

  // Check if a link href points to LinkedIn (internal) vs external destination.
  // safety/go IS internal (a LinkedIn page), but wraps an external URL — we decode it later.
  const isInternalLink = (h) => {
    if (!h) return false;
    return h.startsWith('/') ||
      h.startsWith('https://www.linkedin.com/') ||
      h.startsWith('https://linkedin.com/');
  };

  const rows = [];
  const seen = new Set();

  if (location.pathname.includes('/login')) {
    return {
      loginRequired: true,
      rows: [],
      snapshot: {
        title: document.title || '',
        location: location.href,
        bodyExcerpt: normalize(document.body?.innerText || '').slice(0, 500),
        anchorCount: document.querySelectorAll('a[href]').length,
        feedLinkCount: 0,
      },
    };
  }

  for (const anchor of document.querySelectorAll('a[href]')) {
    const href = normalize(anchor.getAttribute('href') || '');
    const isAuthorLink = href.includes('/in/') || href.includes('/company/');
    if (!isAuthorLink) continue;
    const anchorText = normalize(anchor.innerText || anchor.textContent || '');
    let anchorTimeLabel = findRelativeTimeLabel(anchorText);
    // LinkedIn moved time labels (e.g. "11h •") into sibling <span> elements
    // that are not inside the author <a>. Search the immediate parent element too.
    if (!anchorTimeLabel && anchor.parentElement) {
      const parentText = normalize(anchor.parentElement.textContent || '');
      anchorTimeLabel = findRelativeTimeLabel(parentText);
    }
    const likelyPrimaryAuthorLink =
      Boolean(anchorTimeLabel) || href.includes('/posts/');
    if (!likelyPrimaryAuthorLink) continue;

    const container = pickContainer(anchor);
    const text = normalize(container?.innerText || container?.textContent || '');
    if (!text || text.length < 80) continue;

    const linkCandidates = Array.from(container.querySelectorAll('a[href]'));
    const authorLink =
      linkCandidates.find((node) => {
        const candidate = String(node.getAttribute('href') || '').trim();
        return candidate.includes('/in/') || candidate.includes('/company/');
      }) || anchor;
    const authorHandle = normalize(authorLink?.getAttribute('href') || href);
    const authorName = normalizeAuthorText(authorLink?.innerText || anchor?.innerText || '');
    // Company page anchors often have no innerText (logo-only links).
    // Fall back to extracting the author name from the card text, which
    // always begins with the post author's name before any time/action labels.
    const finalAuthorName = authorName || text.split(/\d+\s*(?:分钟|分|mins?|minutes?|小时|hrs?|hours?|天|days?|周|weeks?|w|个月|月|months?|mos?)/i)[0]
      .split('•')[0]
      .trim();
    // Time label already verified on the anchor — no need to re-check on card text.
    // If we got here, the post is valid.

    // --- URL extraction with priorities ---

    // Priority 1: /feed/update/ permalink (most reliable)
    let sourceLink =
      linkCandidates.find((node) => {
        const candidate = String(node.getAttribute('href') || '').trim();
        return candidate.includes('/feed/update/');
      }) || null;

    // Priority 2: /posts/...-activity-... (specific post, not company feed)
    if (!sourceLink) {
      sourceLink =
        linkCandidates.find((node) => {
          const candidate = String(node.getAttribute('href') || '').trim();
          return candidate.includes('/posts/') && /-activity-/.test(candidate);
        }) || null;
    }

    // Priority 3: First internal (non-author, non-company) link
    if (!sourceLink) {
      sourceLink =
        linkCandidates.find((node) => {
          const candidate = String(node.getAttribute('href') || '').trim();
          if (!candidate) return false;
          if (candidate.includes('/in/') || candidate.includes('/company/')) return false;
          if (candidate.includes('/search/')) return false;
          return isInternalLink(candidate);
        }) || null;
    }

    let resultUrl = sourceLink
      ? toAbsoluteUrl(sourceLink.getAttribute('href') || '')
      : '';

    // Decode safety/go wrapper to get real destination URL.
    // Only keep the decoded URL if it's still a LinkedIn domain (lnkd.in, linkedin.com).
    if (resultUrl && resultUrl.includes('/safety/go/')) {
      try {
        const parsed = new URL(resultUrl);
        const encodedUrl = parsed.searchParams.get('url');
        if (encodedUrl) {
          const decoded = decodeURIComponent(encodedUrl);
          // Only accept if it resolves to a LinkedIn property
          if (
            decoded.startsWith('https://www.linkedin.com/') ||
            decoded.startsWith('https://linkedin.com/') ||
            decoded.startsWith('https://lnkd.in/')
          ) {
            resultUrl = decoded;
          } else {
            // External link (e.g. Google Form) — treat as no valid URL found
            resultUrl = '';
          }
        }
      } catch (_e) {
        // Keep the safety/go URL as fallback if decoding fails
      }
    }

    // Priority 4: Last resort — author profile/company link
    if (!resultUrl) {
      resultUrl = toAbsoluteUrl(href);
    }

    const dedupeKey = `${authorHandle}|${anchorTimeLabel}|${resultUrl}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    rows.push({
      postedAt: '',
      postedAtLabel: anchorTimeLabel,
      url: resultUrl,
      content: text,
      authorHandle,
      authorName: finalAuthorName,
    });

    if (rows.length >= limit) break;
  }

  // Detect if LinkedIn is still visibly loading content.
  // Check for progress bars, spinners — structural DOM indicators only, no text matching.
  let stillLoading = false;
  for (const sel of ['[role="progressbar"]', '[class*="loader"]', '[class*="spinner"]', '[aria-busy="true"]']) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) { stillLoading = true; break; }
  }

  return {
    loginRequired: false,
    rows,
    stillLoading,
    snapshot: {
      title: document.title || '',
      location: location.href,
      bodyExcerpt: normalize(document.body?.innerText || '').slice(0, 800),
      anchorCount: document.querySelectorAll('a[href]').length,
      feedLinkCount: rows.length,
    },
  };
}

/**
 * Find LinkedIn scroll container, scroll it progressively (infinite scroll),
 * then try clicking a "load more" button if present (paginated mode).
 * LinkedIn sometimes uses infinite scroll, sometimes a button — handle both.
 * Returns { scrollH, clientH, scrolled, buttonClicked }.
 */
function scrollAndTryLoadMore() {
  // Priority: #workspace > main > >first element with overflow-scroll > window
  let container = document.querySelector('#workspace') || document.querySelector('main');
  let useWindowScroll = false;

  // If #workspace or main doesn't have scrollable overflow, try window/documentElement
  if (!container || container.scrollHeight <= container.clientHeight + 10 || getComputedStyle(container).overflowY === 'visible') {
    const docEl = document.documentElement;
    if (docEl.scrollHeight > docEl.clientHeight + 10) {
      useWindowScroll = true;
    }
  }

  if (!useWindowScroll && !container) {
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const style = getComputedStyle(el);
      if ((style.overflowY === 'scroll' || style.overflowY === 'auto') && el.scrollHeight > el.clientHeight + 50) {
        container = el;
        break;
      }
    }
  }

  let scrollH = 0;
  let clientH = 0;
  let scrolled = 0;
  const docEl = document.documentElement;
  // Random small step (20-40% viewport) to mimic human reading pace
  const randomStepRatio = 0.2 + Math.random() * 0.2;
  if (useWindowScroll) {
    const before = window.scrollY;
    const step = Math.max(200, Math.floor(window.innerHeight * randomStepRatio));
    window.scrollBy(0, step);
    scrollH = docEl.scrollHeight;
    clientH = window.innerHeight;
    scrolled = window.scrollY - before;
  } else if (container) {
    const before = container.scrollTop;
    const step = Math.max(200, Math.floor(container.clientHeight * randomStepRatio));
    container.scrollTop = Math.min(container.scrollTop + step, container.scrollHeight - container.clientHeight);
    scrollH = container.scrollHeight;
    clientH = container.clientHeight;
    scrolled = container.scrollTop - before;
  }

  // Only scroll — never click buttons here. Button clicks happen only when
  // we're stuck (no new posts for N rounds), in the collectPosts bounce logic.
  return { scrollH, clientH, scrolled, buttonClicked: false };
}

/**
 * Resolve a single post's real URL via the "..." overflow menu.
 * Synchronous version for CDP evaluate — clicks the menu, clicks "复制动态链接",
 * intercepts navigator.clipboard.writeText to capture the URL.
 * Returns { ok, url } or { ok: false, reason }.
 */
async function collectPosts(targetId, maxRounds, meta, days) {
  const rows = [];
  const seen = new Set();
  let loginRequired = false;
  const snapshots = [];

  const DAY_MS = 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const cutoffMs = nowMs - days * DAY_MS;

  let stoppedReason = 'max_rounds';
  // 200 is a hard safety net against infinite loops on broken pages.
  const safetyCap = 200;
  let prevTotalLinks = 0;
  let totalButtonClicks = 0;
  // Single-phase: each stuck round immediately tries button first, then scroll bounce.
  // Track consecutive dead-end attempts; 3 without new content → bottom reached.
  let deadEndCount = 0;

  for (let round = 0; round < safetyCap; round += 1) {
    // Step 1: Scroll the container (triggers infinite scroll)
    await evaluate(targetId, toExpression(scrollAndTryLoadMore), meta);
    // Pause between scrolls (2-3.5s) — give LinkedIn time to render new posts.
    await sleep(2000 + Math.random() * 1500);

    // Step 2: Collect visible posts
    const payload =
      (await evaluate(targetId, toExpression(collectVisiblePosts, 60), meta)) || {
        loginRequired: false,
        rows: [],
      };

    if (payload.loginRequired) {
      loginRequired = true;
      snapshots.push({ round, ...(payload.snapshot || {}) });
      break;
    }

    snapshots.push({ round, ...(payload.snapshot || {}) });

    // Step 3: Count new rows
    let roundNew = 0;
    for (const row of payload.rows || []) {
      const url = String(row?.url || '').trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const label = String(row?.postedAtLabel || '').trim();
      const postMs = parseLinkedInVisibleTimeInline(label, nowMs);
      if (postMs && postMs < cutoffMs) {
        // past cutoff — still collect but count as old
      } else {
        roundNew += 1;
      }
      rows.push(row);
    }

    const totalLinks = seen.size;
    const newThisRound = totalLinks - prevTotalLinks;
    prevTotalLinks = totalLinks;

    // Step 4: Stop conditions.
    // If we found new content or page is still loading, keep scrolling.
    if (newThisRound > 0 || payload.stillLoading) {
      deadEndCount = 0;
      continue;
    }

    // --- stuck: no new posts, not loading ---
    // Immediately check for "Show more results" button (paginated mode).
    // Don't wait for N stuck rounds — if scrollHeight==clientHeight, we're stuck from round 1.
    const btnResult = await evaluate(
      targetId,
      `(() => {
        const btn = document.querySelector('button.scaffold-finite-scroll__load-button');
        if (btn && btn.offsetParent !== null) {
          btn.scrollIntoView({ block: 'center' });
          btn.click();
          return { clicked: true };
        }
        return { clicked: false };
      })()`,
      meta,
    ) || { clicked: false };

    if (btnResult.clicked) {
      totalButtonClicks += 1;
      // Button clicked — wait for page load, then collect.
      await sleep(4000 + Math.random() * 2000);
      const afterClick =
        (await evaluate(targetId, toExpression(collectVisiblePosts, 60), meta)) || {
          rows: [],
        };
      let clickNew = 0;
      for (const row of afterClick.rows || []) {
        const url = String(row?.url || '').trim();
        if (!url || seen.has(url)) continue;
        seen.add(url);
        rows.push(row);
        clickNew += 1;
      }
      if (clickNew > 0) {
        // Button loaded new content! Reset and keep scrolling.
        prevTotalLinks = seen.size;
        deadEndCount = 0;
        continue;
      }
      // Button clicked but no new content — dead end.
      deadEndCount += 1;
      if (deadEndCount >= 3) {
        stoppedReason = 'bottom_reached';
        break;
      }
      continue;
    }

    // No button — do the scroll bounce (for infinite-scroll pages).
    await evaluate(
      targetId,
      `(() => {
        const c = document.querySelector('#workspace') || document.querySelector('main');
        const upPx = Math.floor((window.innerHeight || 700) * (0.3 + Math.random() * 0.2));
        if (c && c.scrollHeight > c.clientHeight + 10 && getComputedStyle(c).overflowY !== 'visible') {
          c.scrollTop = Math.max(0, c.scrollTop - upPx);
        } else {
          window.scrollBy(0, -upPx);
        }
      })()`,
      meta,
    );
    await sleep(2000 + Math.random() * 2000);
    await evaluate(
      targetId,
      `(() => {
        const c = document.querySelector('#workspace') || document.querySelector('main');
        const downPx = Math.floor((window.innerHeight || 700) * (0.4 + Math.random() * 0.2));
        if (c && c.scrollHeight > c.clientHeight + 10 && getComputedStyle(c).overflowY !== 'visible') {
          c.scrollTop = Math.min(c.scrollTop + downPx, c.scrollHeight - c.clientHeight);
        } else {
          window.scrollBy(0, downPx);
        }
      })()`,
      meta,
    );
    await sleep(2000 + Math.random() * 2000);

    // After bounce, collect posts to check if new content appeared.
    const afterBounce =
      (await evaluate(targetId, toExpression(collectVisiblePosts, 60), meta)) || {
        rows: [],
      };
    let bounceNew = 0;
    for (const row of afterBounce.rows || []) {
      const url = String(row?.url || '').trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      rows.push(row);
      bounceNew += 1;
    }

    if (bounceNew > 0) {
      // Bounce triggered new content! Reset.
      prevTotalLinks = seen.size;
      deadEndCount = 0;
      continue;
    }

    // Bounce didn't yield anything new — dead end.
    deadEndCount += 1;
    if (deadEndCount >= 3) {
      stoppedReason = 'bottom_reached';
      break;
    }
  }

  return {
    rows,
    loginRequired,
    snapshots,
    scrollStatus: {
      actualRounds: snapshots.length,
      maxRounds: maxRounds,
      stoppedReason,
      totalDiscovered: seen.size,
      buttonClicks: totalButtonClicks,
    },
  };
}

/**
 * Inline version of parseLinkedInVisibleTime for use in the collect loop.
 * Duplicated from the lib to avoid importing in the browser evaluate context.
 */
function parseLinkedInVisibleTimeInline(label, nowMs) {
  const MINUTE_MS = 60 * 1000;
  const HOUR_MS = 60 * MINUTE_MS;
  const DAY_MS = 24 * HOUR_MS;
  const normalized = String(label || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return null;

  // Try absolute date first
  const absParsed = Date.parse(normalized);
  if (Number.isFinite(absParsed)) return absParsed;

  const patterns = [
    { pattern: /(\d+)\s*(?:分钟|分|mins?|minutes?)/i, unitMs: MINUTE_MS },
    { pattern: /(\d+)\s*(?:小时|hrs?|hours?)/i, unitMs: HOUR_MS },
    { pattern: /(\d+)\s*(?:天|days?)/i, unitMs: DAY_MS },
    { pattern: /(\d+)\s*(?:周|weeks?|w)(?!\S)/i, unitMs: 7 * DAY_MS },
    { pattern: /(\d+)\s*(?:个月|月|months?|mos?)(?!\S)/i, unitMs: 30 * DAY_MS },
  ];
  for (const entry of patterns) {
    const match = normalized.match(entry.pattern);
    if (!match) continue;
    const count = Number.parseInt(match[1], 10);
    if (Number.isFinite(count) && count >= 0) {
      return nowMs - count * entry.unitMs;
    }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const finalUrl = buildLinkedInSearchUrl(args.keyword);

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          keyword: args.keyword,
          days: args.days,
          url: finalUrl,
          maxScrolls: args.maxScrolls,
          maxResults: args.maxResults,
        },
        null,
        2,
      ),
    );
    return;
  }

  await ensureHostBrowserBridge();

  // Clean up any stale LinkedIn search tabs from previous runs (e.g. killed by timeout).
  try {
    const targetsResult = await requestHostBrowser({ action: 'list_targets' }, { timeoutMs: 10000 });
    const allTargets = targetsResult?.targets || [];
    const staleLinkedInTargets = allTargets.filter(
      (t) => t.url && t.url.includes('linkedin.com/search/results/content'),
    );
    for (const t of staleLinkedInTargets) {
      await requestHostBrowser(
        { action: 'close_target', targetId: t.id },
        { timeoutMs: 5000 },
      ).catch(() => {});
    }
    if (staleLinkedInTargets.length > 0) {
      console.error(`Cleaned up ${staleLinkedInTargets.length} stale LinkedIn search tab(s)`);
    }
  } catch (_) {
    // Non-fatal: proceed even if cleanup fails.
  }

  const agentScope = resolveAgentScope();
  let targetId = null;

  // Graceful shutdown: close our tab on SIGTERM / SIGINT.
  const closeCurrentTarget = async () => {
    if (!targetId) return;
    try {
      await requestHostBrowser(
        { action: 'close_target', targetId },
        { timeoutMs: 5000 },
      );
    } catch (_) {}
  };
  const shutdown = () => { closeCurrentTarget().then(() => process.exit(0)); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  try {
    targetId = await createTarget(finalUrl, {
      stage: 'search-open',
      url: finalUrl,
      query: args.keyword,
      taskKind: 'linkedin-search-latest',
      agentScope,
    });

    // Preflight: verify page is healthy before attempting scroll.
    // LinkedIn may need more than 5s to render — retry up to 3 times.
    let preflight = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await sleep(5000);
      preflight = await evaluate(targetId, `(() => {
      const title = document.title || '';
      const isLoginPage = /登录|sign\s*in/i.test(title) ||
        location.pathname.includes('/login') ||
        location.pathname.includes('/checkpoint');
      const isCaptchaPage = /captcha|recaptcha|challenge|验证/i.test(title) ||
        (document.body?.innerText || '').includes('recaptcha') ||
        (document.body?.innerText || '').includes('验证') ||
        location.hostname.includes('recaptcha') ||
        location.hostname.includes('protechts');
      if (isLoginPage) return { ok: false, error: 'LOGIN_REQUIRED', detail: '页面要求登录或验证' };
      if (isCaptchaPage) return { ok: false, error: 'CAPTCHA_DETECTED', detail: 'LinkedIn 返回验证码页面，需要手动验证后重试' };

      const container = document.querySelector('#workspace') || document.querySelector('main');
      if (!container) return { ok: false, error: 'NO_CONTAINER', detail: '找不到滚动容器' };
      if (container.scrollHeight < 100) return { ok: false, error: 'EMPTY_CONTAINER', detail: '页面内容高度异常: ' + container.scrollHeight };

      const authorLinks = document.querySelectorAll('a[href*="/in/"], a[href*="/company/"]');
      if (authorLinks.length === 0) return { ok: false, error: 'NO_CONTENT', detail: '页面未加载到任何内容' };

      const hasErrorMsg = (document.body?.innerText || '').includes('出错了') ||
        (document.body?.innerText || '').includes('something went wrong');
      if (hasErrorMsg) return { ok: false, error: 'PAGE_ERROR', detail: '页面显示错误信息' };

      return {
        ok: true,
        title,
        containerTag: container.tagName,
        scrollH: container.scrollHeight,
        clientH: container.clientHeight,
        authorLinks: authorLinks.length,
        feedLinks: document.querySelectorAll('a[href*="/feed/update/"]').length,
      };
    })()`, { stage: 'preflight', query: args.keyword, taskKind: 'linkedin-search-latest', agentScope });

      if (preflight?.ok) break;
      // Don't retry login/captcha/page-error — those are hard failures.
      if (preflight?.error === 'LOGIN_REQUIRED' || preflight?.error === 'CAPTCHA_DETECTED' || preflight?.error === 'PAGE_ERROR') break;
      // NO_CONTENT, NO_CONTAINER, EMPTY_CONTAINER — may just need more time.
      console.error(`Preflight attempt ${attempt + 1}/3: ${preflight?.error || 'unknown'}`);
    }

    if (!preflight?.ok) {
      console.error('LINKEDIN_PREFLIGHT_FAILED:' + (preflight?.error || 'unknown') + ' ' + (preflight?.detail || ''));
      process.exit(2);
    }

    const { rows, loginRequired, snapshots, scrollStatus } = await collectPosts(
      targetId,
      args.maxScrolls,
      {
        stage: 'search-fetch',
        url: finalUrl,
        query: args.keyword,
        taskKind: 'linkedin-search-latest',
        agentScope,
      },
      args.days,
    );

    if (args.debugDump) {
      fs.writeFileSync(
        args.debugDump,
        JSON.stringify(
          {
            keyword: args.keyword,
            days: args.days,
            finalUrl,
            candidateCount: rows.length,
            rows,
            snapshots,
          },
          null,
          2,
        ),
        'utf8',
      );
    }

    if (loginRequired) {
      const result = buildSearchResultJson({
        keyword: args.keyword,
        finalUrl,
        preflight: { ok: false, error: 'LOGIN_REQUIRED' },
        scrollNote: '页面要求登录',
        rows: [],
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const btnInfo = scrollStatus.buttonClicks > 0 ? `（按钮点击 ${scrollStatus.buttonClicks} 次）` : '（无限滚动模式）';
    const scrollNote = scrollStatus.stoppedReason === 'past_time_range'
        ? `${scrollStatus.actualRounds} 轮后已超出时间范围，自动停止${btnInfo}`
        : scrollStatus.stoppedReason === 'bottom_reached'
          ? `已到底部（${scrollStatus.actualRounds} 轮滚动，共发现 ${scrollStatus.totalDiscovered} 条）${btnInfo}`
          : `${scrollStatus.actualRounds}/${scrollStatus.maxRounds} 轮完成（共发现 ${scrollStatus.totalDiscovered} 条）${btnInfo}`;

    const result = buildSearchResultJson({
      keyword: args.keyword,
      finalUrl,
      preflight,
      scrollNote,
      rows,
    });

    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (targetId) {
      try {
        await closeTarget(targetId, {
          stage: 'search-close',
          url: finalUrl,
          query: args.keyword,
          taskKind: 'linkedin-search-latest',
          agentScope,
        });
      } catch (error) {
        console.error(
          `close_target_failed:${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // Remove signal handlers — tab already closed.
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
