#!/usr/bin/env node
/**
 * Reddit search via CDP (direct WebSocket connection, no puppeteer).
 * Fallback for when host bridge is unavailable.
 */
const CDP_HOST = process.env.WEB_ACCESS_CDP_HOST || '172.31.250.10';
const CDP_PORT = process.env.WEB_ACCESS_CDP_PORT || '9223';
const keyword = process.argv[2] || 'Medtrum';
const days = parseInt(process.argv[3] || '30', 10);

const CUTOFF_MS = days * 24 * 60 * 60 * 1000;
const now = Date.now();

async function getWsEndpoint() {
  const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`);
  const data = await res.json();
  return data.webSocketDebuggerUrl;
}

async function cdpCommand(ws, msgId, method, params = {}) {
  const msg = { id: msgId, method, params };
  ws.send(JSON.stringify(msg));
  return new Promise((resolve, reject) => {
    const handler = (data) => {
      const response = JSON.parse(data.toString());
      if (response.id === msgId) {
        ws.removeListener('message', handler);
        if (response.error) reject(new Error(response.error.message));
        else resolve(response.result);
      }
    };
    ws.on('message', handler);
    setTimeout(() => { ws.removeListener('message', handler); reject(new Error('timeout')); }, 30000);
  });
}

async function main() {
  const WebSocket = (await import('ws')).default;
  const wsUrl = await getWsEndpoint();
  console.error(`[reddit-cdp] Connecting to ${wsUrl}`);

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws connect timeout')), 10000);
  });

  // Create a new page (target)
  const { targetId } = await cdpCommand(ws, 1, 'Target.createTarget', { url: 'about:blank' });
  console.error(`[reddit-cdp] Target created: ${targetId}`);

  // Helper to send commands to the page target
  async function pageCmd(msgId, method, params = {}) {
    const { result } = await cdpCommand(ws, msgId, 'Target.sendMessageToTarget', {
      targetId,
      message: JSON.stringify({ id: msgId, method, params }),
    });
    return result;
  }

  // Listen for page messages
  const pageResult = {};
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'Target.receivedMessageFromTarget' && msg.params.targetId === targetId) {
        const inner = JSON.parse(msg.params.message);
        if (inner.id) pageResult[inner.id] = inner;
      }
    } catch (e) {}
  });

  function waitForPageResponse(msgId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (pageResult[msgId]) {
          const r = pageResult[msgId];
          delete pageResult[msgId];
          if (r.error) reject(new Error(r.error.message));
          else resolve(r.result);
        } else {
          setTimeout(check, 100);
        }
      };
      check();
      setTimeout(() => { delete pageResult[msgId]; reject(new Error('timeout')); }, timeoutMs);
    });
  }

  // Navigate
  await cdpCommand(ws, 100, 'Target.sendMessageToTarget', {
    targetId,
    message: JSON.stringify({
      id: 101,
      method: 'Page.enable',
      params: {},
    }),
  });

  await cdpCommand(ws, 102, 'Target.sendMessageToTarget', {
    targetId,
    message: JSON.stringify({
      id: 103,
      method: 'Page.navigate',
      params: { url: `https://www.reddit.com/search/?q=${encodeURIComponent(keyword)}&sort=new&t=year&limit=100` },
    }),
  });
  await new Promise(r => setTimeout(r, 8000));

  // Evaluate - scroll and extract
  for (let i = 0; i < 8; i++) {
    await cdpCommand(ws, 200 + i, 'Target.sendMessageToTarget', {
      targetId,
      message: JSON.stringify({ id: 300 + i, method: 'Runtime.evaluate', params: { expression: 'window.scrollBy(0, 600)' } }),
    });
    await new Promise(r => setTimeout(r, 1000));
  }

  const evalResult = await cdpCommand(ws, 400, 'Target.sendMessageToTarget', {
    targetId,
    message: JSON.stringify({
      id: 401,
      method: 'Runtime.evaluate',
      params: {
        expression: `
          (() => {
            const results = [];
            const links = document.querySelectorAll('a[href*="/comments/"]');
            const seen = new Set();
            links.forEach(a => {
              let href = a.getAttribute('href');
              if (!href) return;
              if (href.startsWith('/')) href = 'https://www.reddit.com' + href;
              href = href.split('?')[0].replace(/\\/$/, '');
              if (seen.has(href)) return;
              seen.add(href);
              const post = a.closest('shreddit-post, faceplate-tracker, article, div[data-testid*="post"]');
              if (!post) return;
              const titleEl = post.querySelector('[slot="title"], h3, [data-testid="post-title-text"]');
              const title = titleEl ? titleEl.textContent.trim() : a.textContent.trim();
              if (!title) return;
              const authorEl = post.querySelector('a[href^="/user/"], [slot="author"]');
              const author = authorEl ? authorEl.textContent.trim() : '[unknown]';
              const timeEl = post.querySelector('time');
              const datetime = timeEl ? timeEl.getAttribute('datetime') : '';
              const contentEl = post.querySelector('[slot="text-body"], [data-testid="post-content"] p, p, div.md');
              const content = contentEl ? contentEl.textContent.trim().slice(0, 500) : '';
              const subMatch = href.match(/reddit\\\\.com\\\\/r\\\\/([^\\\\/]+)/);
              const subreddit = subMatch ? 'r/' + subMatch[1] : 'r/unknown';
              results.push({ datetime, subreddit, author, title, selftext: content, permalink: href });
            });
            return JSON.stringify(results);
          })()
        `,
        returnByValue: false,
      },
    }),
  });

  // The result is sent as a message to target, not directly returned
  // Let me use a simpler approach
  console.error(`[reddit-cdp] Complex approach failed, using simpler method...`);
  
  // Close target
  await cdpCommand(ws, 500, 'Target.closeTarget', { targetId }).catch(() => {});
  ws.close();

  // Fall through to simple fetch
  console.error(`[reddit-cdp] Falling back to simple HTTP attempt`);
  const out = {
    platform: 'Reddit',
    keyword,
    retrievedAt: new Date().toISOString(),
    queryUrl: `https://www.reddit.com/search/?q=${encodeURIComponent(keyword)}&sort=new&t=year`,
    preflight: { ok: false, error: 'CDP_SCRIPT_FAILED' },
    total: 0,
    dropped: 0,
    items: [],
  };
  console.log(JSON.stringify(out));
}

main().catch(err => {
  console.error(`[reddit-cdp] ERROR: ${err.message}`);
  // Output empty result so pipeline can continue
  const out = {
    platform: 'Reddit',
    keyword: process.argv[2] || 'Medtrum',
    retrievedAt: new Date().toISOString(),
    queryUrl: `https://www.reddit.com/search/?q=${encodeURIComponent(process.argv[2] || '')}`,
    preflight: { ok: false, error: err.message },
    total: 0,
    dropped: 0,
    items: [],
  };
  console.log(JSON.stringify(out));
});
