#!/usr/bin/env node
/**
 * Reddit search via direct CDP WebSocket using ws module.
 * Replaces reddit-search-runner.mjs when host bridge is unavailable.
 */
import WebSocket from 'ws';

const CDP_HOST = process.env.WEB_ACCESS_CDP_HOST || '172.31.250.10';
const CDP_PORT = parseInt(process.env.WEB_ACCESS_CDP_PORT || '9223');
const keyword = process.argv[2];
const days = parseInt(process.argv[3] || '30', 10);
const CUTOFF_MS = days * 24 * 60 * 60 * 1000;
const now = Date.now();

class CDPClient {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.msgId = 0;
    this.pending = new Map();
  }

  async connect() {
    const res = await fetch(`http://${this.host}:${this.port}/json/version`);
    const data = await res.json();
    const wsUrl = data.webSocketDebuggerUrl;
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (data) => this._onMessage(data));
      setTimeout(() => reject(new Error('WS connect timeout')), 15000);
    });
  }

  _onMessage(data) {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    } catch (e) {}
  }

  async send(method, params = {}) {
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, 30000);
    });
  }

  async createPage(url) {
    const { targetId } = await this.send('Target.createTarget', { url });
    this.pageTargetId = targetId;
    return targetId;
  }

  async pageCmd(method, params = {}) {
    const id = ++this.msgId;
    const innerId = id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({
        id,
        method: 'Target.sendMessageToTarget',
        params: { targetId: this.pageTargetId, message: JSON.stringify({ id: innerId, method, params }) },
      }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`Timeout: ${method}`)); }
      }, 30000);
    });
  }

  async navigate(url) {
    await this.pageCmd('Page.enable');
    const result = await this.pageCmd('Page.navigate', { url });
    // Wait for page load
    await new Promise(r => setTimeout(r, 8000));
    return result;
  }

  async scroll(steps) {
    for (let i = 0; i < steps; i++) {
      await this.pageCmd('Runtime.evaluate', { expression: 'window.scrollBy(0, 700);' });
      await new Promise(r => setTimeout(r, 1200));
    }
  }

  async evaluate(expression) {
    const result = await this.pageCmd('Runtime.evaluate', { expression, returnByValue: true });
    return result?.result?.value;
  }

  async close() {
    if (this.pageTargetId) {
      await this.send('Target.closeTarget', { targetId: this.pageTargetId }).catch(() => {});
    }
    this.ws.close();
  }
}

async function main() {
  const cdp = new CDPClient(CDP_HOST, CDP_PORT);
  await cdp.connect();
  
  const searchUrl = `https://www.reddit.com/search/?q=${encodeURIComponent(keyword)}&sort=new&t=year`;
  console.error(`[reddit-cdp] ${keyword}: opening ${searchUrl}`);

  await cdp.createPage('about:blank');
  await cdp.navigate(searchUrl);

  // Check for login wall
  const pageText = await cdp.evaluate('document.body?.innerText?.slice(0,500) || ""');
  if (pageText.toLowerCase().includes('log in') && !pageText.toLowerCase().includes('logout') && pageText.length < 300) {
    console.error(`[reddit-cdp] PREFLIGHT_FAILED: Login required`);
    const out = { platform: 'Reddit', keyword, retrievedAt: new Date().toISOString(), queryUrl: searchUrl, preflight: { ok: false, error: 'LOGIN_REQUIRED' }, total: 0, dropped: 0, items: [] };
    console.log(JSON.stringify(out));
    await cdp.close();
    return;
  }

  // Scroll to load more
  await cdp.scroll(10);

  // Extract posts
  const postsJson = await cdp.evaluate(`
    (() => {
      const results = [];
      const links = document.querySelectorAll('a[href*="/comments/"]');
      const seen = new Set();
      links.forEach(a => {
        let href = a.getAttribute('href') || '';
        if (href.startsWith('/')) href = 'https://www.reddit.com' + href;
        href = href.split('?')[0].replace(/\\/$/, '');
        if (!href.includes('/comments/') || seen.has(href)) return;
        seen.add(href);
        
        const post = a.closest('shreddit-post, faceplate-tracker, article, div[data-testid*="post"], li');
        if (!post) return;
        
        const titleEl = post.querySelector('[slot="title"], h3, [data-testid="post-title-text"], a[href*="/comments/"] h3');
        const title = titleEl ? titleEl.textContent.trim() : a.textContent.trim();
        if (!title || title.length < 3) return;
        
        const authorEl = post.querySelector('a[href^="/user/"], [slot="author"]');
        const author = authorEl ? authorEl.textContent.trim() : '[unknown]';
        
        const timeEl = post.querySelector('time');
        const datetime = timeEl ? timeEl.getAttribute('datetime') : '';
        
        const subMatch = href.match(/reddit\\\\.com\\/r\\/([^\\/]+)/);
        const subreddit = subMatch ? 'r/' + subMatch[1] : 'r/unknown';
        
        results.push({ datetime, subreddit, author, title, permalink: href });
      });
      return JSON.stringify(results);
    })()
  `);

  let posts = [];
  try { posts = JSON.parse(postsJson); } catch (e) { posts = []; }
  console.error(`[reddit-cdp] Raw: ${posts.length} posts`);

  // Filter by date
  const filtered = posts.filter(p => {
    if (!p.datetime) return true;
    const d = new Date(p.datetime).getTime();
    return isNaN(d) || (now - d) <= CUTOFF_MS;
  });
  console.error(`[reddit-cdp] After date filter: ${filtered.length}`);

  const out = {
    platform: 'Reddit',
    keyword,
    retrievedAt: new Date().toISOString(),
    queryUrl: searchUrl,
    preflight: { ok: true },
    scrollStatus: { actualScrolls: 10, maxScrolls: 10, stoppedReason: 'completed' },
    total: filtered.length,
    dropped: 0,
    items: filtered.map(p => ({
      date: p.datetime || '',
      author: p.author,
      content: p.title,
      url: p.permalink,
      subreddit: p.subreddit,
    })),
  };

  console.log(JSON.stringify(out));
  await cdp.close();
}

main().catch(err => {
  console.error(`[reddit-cdp] ERROR: ${err.message}`);
  const out = {
    platform: 'Reddit',
    keyword,
    retrievedAt: new Date().toISOString(),
    preflight: { ok: false, error: err.message },
    total: 0, dropped: 0, items: [],
  };
  console.log(JSON.stringify(out));
});
