#!/usr/bin/env node

import process from 'node:process';

import {
  buildXSearchUrl,
  formatXSearchResult,
  selectRecentRelevantTweets,
} from './x_search_lib.mjs';
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
    maxResults: 100,
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
      args.maxScrolls = Number(argv[index + 1] || '5');
      index += 1;
      continue;
    }
    if (token === '--max-results') {
      args.maxResults = Number(argv[index + 1] || '100');
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

async function scrollToY(targetId, y, meta) {
  await browserCommand({ action: 'scroll', targetId, y }, meta);
}

async function getWindowHeight(targetId, meta) {
  return await evaluate(targetId, 'window.innerHeight', meta);
}

async function closeTarget(targetId, meta) {
  await browserCommand({ action: 'close_target', targetId }, meta);
}



function toExpression(factory, ...args) {
  return `(${factory.toString()})(${args
    .map((arg) => JSON.stringify(arg))
    .join(',')})`;
}

function collectVisibleTweets(limit) {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const rows = [];
  const seen = new Set();

  for (const article of document.querySelectorAll('article')) {
    const timeEl = article.querySelector('time');
    const postedAt = normalize(timeEl?.getAttribute('datetime') || '');
    if (!postedAt) continue;

    const linkEl = article.querySelector('a[href*="/status/"]');
    const href = normalize(linkEl?.getAttribute('href') || '');
    if (!href) continue;

    let url = '';
    try {
      url = new URL(href, location.origin).toString();
    } catch {
      continue;
    }
    if (!/\/status\/\d+/.test(url) || seen.has(url)) continue;
    seen.add(url);

    const tweetTextNodes = Array.from(
      article.querySelectorAll('[data-testid="tweetText"]'),
    );
    const content = normalize(
      tweetTextNodes.map((node) => node.textContent || '').join(' '),
    );
    if (!content) continue;

    const handleMatch = href.match(/^\/([^/]+)\/status\//);
    const authorHandle = handleMatch ? `@${handleMatch[1]}` : '';
    const authorName = normalize(
      article.querySelector('div[dir="ltr"] span')?.textContent || '',
    );

    rows.push({
      postedAt,
      url,
      content,
      authorHandle,
      authorName,
    });

    if (rows.length >= limit) break;
  }

  return rows;
}

async function collectTweets(targetId, maxScrolls, meta, days) {
  const rows = [];
  const seen = new Set();

  const DAY_MS = 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const cutoffMs = nowMs - days * DAY_MS;

  // 获取窗口高度，用于计算滚动步长
  const windowHeight = await getWindowHeight(targetId, meta) || 800;
  // 每次滚动窗口高度的 80%，避免滚太快漏掉内容
  const scrollStep = Math.floor(windowHeight * 0.8);
  let scrollY = 0;
  let noNewCount = 0;
  let consecutiveOldBatches = 0;
  const maxNoNew = 3; // 连续 3 次无新内容则停止
  let actualScrolls = 0;
  let stoppedReason = 'max_scrolls'; // 默认是达到上限

  for (let step = 0; step < maxScrolls; step += 1) {
    actualScrolls = step + 1;
    // 初始加载等待更久，后续每次滚动后等待
    const waitMs = step === 0 ? 5000 : 2500;
    await sleep(waitMs);

    const currentRows =
      (await evaluate(targetId, toExpression(collectVisibleTweets, 50), meta)) || [];

    let newCount = 0;
    let oldCount = 0;
    for (const row of currentRows) {
      const url = String(row?.url || '').trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      rows.push(row);
      // Check if tweet is older than cutoff
      const postMs = Date.parse(row.postedAt || '');
      if (postMs && postMs < cutoffMs) {
        oldCount += 1;
      } else {
        newCount += 1;
      }
    }

    // Stop if 3 consecutive rounds have only old tweets
    if (oldCount > 0 && newCount === 0) {
      consecutiveOldBatches += 1;
      if (consecutiveOldBatches >= 3) {
        stoppedReason = 'past_time_range';
        break;
      }
    } else {
      consecutiveOldBatches = 0;
    }

    // 连续多次无新内容时提前停止
    if (oldCount === 0 && newCount === 0) {
      noNewCount += 1;
      if (noNewCount >= maxNoNew) {
        stoppedReason = 'no_new_content';
        break;
      }
    } else {
      noNewCount = 0;
    }

    // 小幅度滚动，不是直接到底
    scrollY += scrollStep;
    await scrollToY(targetId, scrollY, meta);
  }

  return { rows, scrollStatus: { actualScrolls, maxScrolls, stoppedReason } };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const finalUrl = buildXSearchUrl(args.keyword);

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

  const agentScope = resolveAgentScope();
  let targetId = null;
  try {
    targetId = await createTarget(finalUrl, {
      stage: 'search-open',
      url: finalUrl,
      query: args.keyword,
      taskKind: 'x-search-latest',
      agentScope,
    });

    // Preflight: verify page is healthy
    await sleep(5000);
    const preflight = await evaluate(targetId, `(() => {
      const title = document.title || '';
      if (title.includes('login') || title.includes('Log in') || title.includes('登入')) return { ok: false, error: 'LOGIN_REQUIRED', detail: 'X requires login' };
      if (!title) return { ok: false, error: 'EMPTY_PAGE', detail: 'Page did not load' };
      const tweets = document.querySelectorAll('[data-testid="tweet"], [data-testid="tweetText"]');
      if (tweets.length === 0) return { ok: false, error: 'NO_TWEETS', detail: 'No tweets found on page' };
      return { ok: true, title, tweetCount: tweets.length };
    })()`, { stage: 'preflight', query: args.keyword });
    if (!preflight?.ok) {
      console.error('X_PREFLIGHT_FAILED:' + (preflight?.error || 'unknown') + ' ' + (preflight?.detail || ''));
      process.exitCode = 2;
      return;
    }

    const { rows, scrollStatus } = await collectTweets(targetId, args.maxScrolls, {
      stage: 'search-fetch',
      url: finalUrl,
      query: args.keyword,
      taskKind: 'x-search-latest',
      agentScope,
    }, args.days);

    const selected = selectRecentRelevantTweets(rows, {
      keyword: args.keyword,
      days: args.days,
    }).slice(0, args.maxResults);

    // Build and validate items
    const validItems = [];
    let dropped = 0;
    for (const row of selected) {
      const date = String(row.postedAt || '').slice(0, 10).trim();
      const author = (row.authorName || row.authorHandle || '').trim();
      const content = (row.content || '').replace(/\s+/g, ' ').trim();
      let url = String(row.url || '').trim();

      if (!date) { dropped++; continue; }
      if (!author) { dropped++; continue; }
      if (!content || content.length < 10) { dropped++; continue; }
      if (url && !url.startsWith('https://x.com/') && !url.startsWith('https://twitter.com/')) url = '';

      validItems.push({ date, author, content, url: url || null });
    }

    const result = {
      platform: 'X',
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
      try {
        await closeTarget(targetId, {
          stage: 'search-close',
          url: finalUrl,
          query: args.keyword,
          taskKind: 'x-search-latest',
          agentScope,
        });
      } catch (error) {
        console.error(
          `close_target_failed:${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});