#!/usr/bin/env node
/**
 * 小红书搜索脚本（2026-05-01 实测版）
 *
 * 用法:
 *   node xhs-search.mjs search --keyword "AI工具"
 *   node xhs-search.mjs search --keyword "AI工具" --sort time_descending --page 2
 *   node xhs-search.mjs search --keyword "AI工具" --with-detail --max-results 3
 *   node xhs-search.mjs detail --note-id "6523a4c7000000001a012345"
 *
 * 架构:
 *   1. 通过代理打开搜索页面（SPA 动态加载结果）
 *   2. 等到笔记 DOM 渲染完成
 *   3. 从 DOM 提取笔记信息
 *   4. 笔记详情: 打开笔记页面，从 __INITIAL_STATE__ 提取
 *   5. 始终 try-finally 关闭页面
 *
 * 依赖: web-access 浏览器 sidecar
 */

import WebSocket from '/app/node_modules/ws/lib/websocket.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(__dirname, '..');

// ─── 配置 ───────────────────────────────────────────────────────
const CDP_BASE = 'http://172.31.250.10:9223';
const PROXY_BASE = 'http://127.0.0.1:3456';

const SCOPE_ENV_NAMES = ['CLAUDE_AGENT_ID', 'CLAUDE_HOOK_AGENT_ID', 'agent_id'];

function resolveAgentScope(defaultPrefix = 'xhs-search') {
  for (const name of SCOPE_ENV_NAMES) {
    const val = (process.env[name] || '').trim();
    if (val) return val;
  }
  return `${defaultPrefix}-${Date.now()}`;
}

// 排序参数映射
const SORT_OPTIONS = {
  'general': 'general',
  '综合': 'general',
  'time_descending': 'time_descending',
  '最新': 'time_descending',
  'popularity_descending': 'popularity_descending',
  '最多点赞': 'popularity_descending',
  'comment_descending': 'comment_descending',
  '最多评论': 'comment_descending',
  'collect_descending': 'collect_descending',
  '最多收藏': 'collect_descending',
};

// ─── 工具函数 ───────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 随机化等待：模拟人类行为，min~max 毫秒间随机
function randomSleep(min, max) {
  const ms = min + Math.floor(Math.random() * (max - min + 1));
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 随机化等待：在 min~max 毫秒之间随机

// ─── 代理 API ───────────────────────────────────────────────────

async function proxyNew(url, scope) {
  const resp = await fetch(
    `${PROXY_BASE}/new?url=${encodeURIComponent(url)}&metaAgentScope=${scope}`
  );
  return await resp.json();
}

async function proxyCloseAll(scope) {
  await fetch(
    `${PROXY_BASE}/session/close-all?metaAgentScope=${scope}`,
    { method: 'POST' }
  ).catch(() => {});
}

// ─── CDP 工具 ───────────────────────────────────────────────────

async function connectCdpToTarget(targetId) {
  const resp = await fetch(`${CDP_BASE}/json/list`);
  const pages = await resp.json();
  const page = pages.find(p => p.id === targetId) || pages[pages.length - 1];
  if (!page) return null;

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let msgId = 1;
  const pending = new Map();

  ws.on('message', data => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  function send(method, params = {}) {
    return new Promise(resolve => {
      const id = msgId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  return {
    eval: async (expression, awaitPromise = false) => {
      const result = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise,
        emulateUserGesture: true,
      });
      const cmdResult = result?.result;
      if (!cmdResult) return undefined;
      if (cmdResult.exceptionDetails) {
        return {
          _error: true,
          text: cmdResult.exceptionDetails.text || 'Unknown error',
          description: cmdResult.exceptionDetails.exception?.description || '',
        };
      }
      return cmdResult.result?.value;
    },
    send,
    close: () => ws.close(),
  };
}

// ─── DOM 提取搜索笔记（实测 2026-05-01）──────────────────────────

/**
 * 在搜索结果页面上提取笔记卡片数据
 * 实测 DOM 结构:
 *   <section class="note-item">
 *     <a class="cover mask ld" href="/explore/xxx"><img src="cover.jpg"></a>
 *     <div class="footer">
 *       <a class="title"><span>标题文字</span></a>
 *       <div class="card-bottom-wrapper">
 *         <a class="author"><img class="author-avatar"> <div class="name">作者名</div></a>
 *         ...
 */
function EXTRACT_NOTES_JS() {
  return "(() => {\n  const items = document.querySelectorAll('section.note-item');\n  if (!items || items.length === 0) {\n    return { ok: false, error: 'DOM: no note-item found', count: 0 };\n  }\n  const notes = Array.from(items).map(function(item) {\n    // note_id from hidden /explore/ link or visible /search_result/ link\n    var allLinks = item.querySelectorAll('a');\n    var noteId = '';\n    for (var i = 0; i < allLinks.length; i++) {\n      var h = allLinks[i].getAttribute('href') || '';\n      var m = h.match(//explore\\/([^/?]+)/);\n      if (m) { noteId = m[1]; break; }\n    }\n    if (!noteId) {\n      var coverHref = item.querySelector('a.cover')?.getAttribute('href') || '';\n      var m2 = coverHref.match(/\\/search_result\\/([^/?]+)/);\n      if (m2) noteId = m2[1];\n    }\n    var coverLink = item.querySelector('a.cover');\n    var coverImg = coverLink ? coverLink.querySelector('img') : null;\n    var cover = coverImg ? coverImg.src : '';\n    var titleLink = item.querySelector('a.title');\n    var titleSpan = titleLink ? titleLink.querySelector('span') : null;\n    var title = titleSpan ? titleSpan.textContent.trim() : (titleLink ? titleLink.textContent.trim() : '');\n    var authorEl = item.querySelector('div.name');\n    var author = authorEl ? authorEl.textContent.trim() : '';\n    var authorAvatar = item.querySelector('img.author-avatar');\n    var avatar = authorAvatar ? authorAvatar.src : '';\n    var authorLink = item.querySelector('a.author');\n    var authorHref = authorLink ? authorLink.getAttribute('href') || '' : '';\n    var authorId = authorHref.match(/\\/user\\/profile\\/([^/?]+)/) ? authorHref.match(/\\/user\\/profile\\/([^/?]+)/)[1] : '';\n    var hrefAttr = coverLink ? coverLink.getAttribute('href') || '' : '';\n    var qs = hrefAttr.split('?')[1] || '';\n    var xsecToken = '';\n    if (typeof URLSearchParams !== 'undefined') {\n      xsecToken = new URLSearchParams(qs).get('xsec_token') || '';\n    }\n    var url = noteId ? 'https://www.xiaohongshu.com/explore/' + noteId : '';\n    return {\n      note_id: noteId,\n      title: title || '(无标题)',\n      author: author,\n      author_id: authorId,\n      avatar: avatar,\n      cover: cover,\n      xsec_token: xsecToken,\n      url: url\n    };\n  }).filter(function(n) { return n.note_id; });\n  return { ok: true, count: notes.length, notes: notes };\n})()";
}

async function waitForNotes(cdp, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await cdp.eval(`(() => {
      const items = document.querySelectorAll('section.note-item');
      return { count: items.length, sample: items[0]?.querySelector('a.title span')?.textContent?.trim()?.slice(0, 30) || '' };
    })()`);
    if (result && result.count > 0) {
      console.error(`  ✅ 笔记已渲染: ${result.count} 条`);
      if (result.sample) console.error(`  首条标题: ${result.sample}`);
      return result.count;
    }
    if (result && result._error) {
      console.error(`  DOM 查询错误: ${result.text}`);
      break;
    }
    await sleep(1500);
  }
  return 0;
}

// ─── 搜索 ────────────────────────────────────────────────────────

async function searchNotes(keyword, options = {}) {
  const {
    sort = 'general',
    page = 1,
    pageSize = 20,
    noteType = 'all',
  } = options;

  const sortParam = SORT_OPTIONS[sort] || 'general';
  const scope = resolveAgentScope();
  let cdp = null;

  console.error(`[搜索] 关键词: "${keyword}"  排序: ${sortParam}`);

  try {
    // 1. 构造搜索 URL（小红书 SPA 直接打开搜索页面）
    const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&sort=${sortParam}`;
    console.error('[搜索] 打开搜索页面...');
    const newResult = await proxyNew(searchUrl, scope);
    const targetId = newResult.targetId;
    if (!targetId) return { ok: false, error: '无法创建页面' };
    console.error(`  targetId: ${targetId}`);

    // 2. 等页面渲染（SPA 需要时间加载 JS 并执行，给足缓冲）
    await sleep(3000);

    // 3. 连接 CDP
    console.error('[搜索] 连接 CDP...');
    cdp = await connectCdpToTarget(targetId);
    if (!cdp) return { ok: false, error: '无法连接 CDP' };

    // 4. 如果不是综合排序，先打开筛选面板选择排序方式
    if (sortParam !== 'general') {
      console.error(`[搜索] 选择排序: ${sortParam}...`);
      // 等待页面完全加载后再操作筛选按钮
      await randomSleep(2000, 3000);      const sortLabel = {
        'time_descending': '最新',
        'popularity_descending': '最多点赞',
        'comment_descending': '最多评论',
        'collect_descending': '最多收藏',
      }[sortParam] || null;

      if (sortLabel) {
        // 打开筛选面板
        await cdp.eval(`(() => {
          var btn = document.querySelector('div.filter');
          if (btn) { btn.click(); return true; }
          return false;
        })()`);
        await sleep(1500);        // 点击排序选项
        const clicked = await cdp.eval(`(() => {
          var tags = document.querySelectorAll('div.tags');
          for (var i = 0; i < tags.length; i++) {
            if ((tags[i].textContent || '').trim() === '${sortLabel}') {
              tags[i].click();
              return true;
            }
          }
          return false;
        })()`);
                console.error(`  排序选项"${sortLabel}" ${clicked ? '已点击' : '未找到'}`);

        // 笔记类型筛选
        if (noteType === 'video' || noteType === 'image') {
          const typeLabel = noteType === 'video' ? '视频' : '图文';
          const typeClicked = await cdp.eval(`(() => {
            var tags = document.querySelectorAll('div.tags');
            var found = [];
            for (var i = 0; i < tags.length; i++) {
              if ((tags[i].textContent || '').trim() === '${typeLabel}') {
                found.push(tags[i]);
              }
            }
            // 笔记类型标签在排序标签后面，取靠后的
            var target = found.length > 0 ? found[found.length - 1] : null;
            if (target) { target.click(); return true; }
            return false;
          })()`);
          console.error(`  笔记类型"${typeLabel}" ${typeClicked ? '已点击' : '未找到'}`);
          await sleep(500);
        }

        await sleep(1000);

        // 关掉筛选面板（点击收起）
        await cdp.eval(`(() => {
          var ops = document.querySelectorAll('div.operation');
          for (var i = 0; i < ops.length; i++) {
            if ((ops[i].textContent || '').trim() === '收起') {
              ops[i].click(); return true;
            }
          }
          return false;
        })()`);

        // 等待新结果加载（轮询直到笔记重新渲染）
        console.error('  等待排序后的新结果...');
        const afterSortCount = await waitForNotes(cdp, 15000);
        if (afterSortCount > 0) {
          console.error(`  ${afterSortCount} 条 (排序后)`);
        } else {
          console.error('  排序后未检测到笔记，继续等待...');
          await sleep(3000);
        }
      }
    }

    // 5. 等待笔记 DOM 渲染
    console.error('[搜索] 等待笔记渲染...');
    const count = await waitForNotes(cdp);
    if (count === 0) {
      // 尝试打印页面信息协助排查
      const pageInfo = await cdp.eval(`({ url: location.href, title: document.title, bodyLen: document.body?.innerText?.length })`);
      console.error('  页面信息:', JSON.stringify(pageInfo));
      return { ok: false, error: '未找到搜索结果，可能需要登录或页面加载失败', pageInfo };
    }

    // 5. 提取笔记数据（支持滚动加载更多）
    console.error(`[搜索] 提取笔记数据...`);
    const extractJs = EXTRACT_NOTES_JS();
    let allNotes = [];

    // 首次提取
    let firstResult = await cdp.eval(extractJs);
    if (!firstResult || !firstResult.ok) {
      return { ok: false, error: firstResult?.error || '提取失败' };
    }
    allNotes = firstResult.notes || [];
    console.error(`  ${allNotes.length} 条 (首次加载)`);

    // 如果 pageSize > 当前数量，尝试滚动加载更多
    const targetCount = Math.max(pageSize, 30);
    if (allNotes.length < targetCount) {
      console.error(`[搜索] 滚动加载更多...`);
      for (let scrollRound = 0; scrollRound < 5; scrollRound++) {
        // 滚动到底部
        await cdp.eval(`window.scrollTo(0, document.body.scrollHeight);`);
        console.error(`  滚动中... (${scrollRound + 1}/5)`);
        await randomSleep(2000, 3500);
        // 等待新内容
        let beforeCount = allNotes.length;
        for (let wait = 0; wait < 6; wait++) {
          await randomSleep(1000, 2000);
          let nextResult = await cdp.eval(extractJs);
          if (nextResult && nextResult.ok) {
            // 去重合并
            const existingIds = new Set(allNotes.map(n => n.note_id));
            for (const n of (nextResult.notes || [])) {
              if (!existingIds.has(n.note_id)) {
                allNotes.push(n);
                existingIds.add(n.note_id);
              }
            }
          }
          if (allNotes.length > beforeCount || allNotes.length >= targetCount) break;
        }
        console.error(`  第${scrollRound + 1}次滚动: ${allNotes.length} 条`);
        if (allNotes.length >= targetCount) break;
        // 如果滚了也没新内容，提前结束
        if (allNotes.length === beforeCount) {
          console.error('  没有更多内容了');
          break;
        }
      }
    }

    // 6. 分页截取
    const startIdx = (page - 1) * pageSize;
    const pageNotes = allNotes.slice(startIdx, startIdx + pageSize);
    const hasMore = allNotes.length > startIdx + pageSize;

    // 保存搜索历史
    try {
      const historyPath = resolve(SKILL_DIR, 'search-history.json');
      let history = [];
      try {
        const raw = readFileSync(historyPath, 'utf-8');
        history = JSON.parse(raw);
      } catch(e) {}
      history.unshift({
        keyword: keyword,
        sort: sortParam,
        noteType: noteType,
        pageSize: pageSize,
        noteCount: allNotes.length,
        timestamp: new Date().toISOString(),
      });
      if (history.length > 50) history = history.slice(0, 50);
      writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf-8');
    } catch(e) {}

    return {
      ok: true,
      keyword,
      sort: sortParam,
      page,
      total: allNotes.length,
      hasMore,
      resultCount: pageNotes.length,
      results: pageNotes,
      source: 'browser_dom',
    };
  } finally {
    if (cdp) { try { cdp.close(); } catch (e) {} }
    try { await proxyCloseAll(scope); } catch (e) {}
  }
}

// ─── 笔记详情 ────────────────────────────────────────────────────

async function getNoteDetail(noteId, xsecToken) {
  if (!noteId || /^\s*$/.test(noteId)) {
    return { ok: false, error: '请提供有效的 note_id' };
  }

  const scope = resolveAgentScope('xhs-detail');
  let cdp = null;

  console.error(`[详情] 笔记 ID: ${noteId}`);

  try {
    // 1. 打开笔记页面（带 xsec_token 避免 404）
    console.error('[详情] 打开笔记页面...');
    let noteUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
    if (xsecToken) {
      noteUrl += '?xsec_token=' + encodeURIComponent(xsecToken) + '&xsec_source=pc_search';
    }
    const newResult = await proxyNew(noteUrl, scope);
    const targetId = newResult.targetId;
    if (!targetId) return { ok: false, error: '无法创建页面' };
    console.error(`  targetId: ${targetId}`);

    // 2. 等待页面加载 + SPA 渲染（给足缓冲）
    await sleep(5000);

    // 3. 连接 CDP
    console.error('[详情] 连接 CDP...');
    cdp = await connectCdpToTarget(targetId);
    if (!cdp) return { ok: false, error: '无法连接 CDP' };

    // 4. 等待并提取笔记内容（DOM 方式，轮询直到正文出现）
    console.error('[详情] 等待正文渲染...');
    let noteData = null;
    for (let i = 0; i < 15; i++) {
      await sleep(1500);
      noteData = await cdp.eval(`(() => {
        // 找笔记正文 - 通常在一个 .desc 元素里
        var descEl = document.querySelector('[class*=desc]');
        var descText = descEl ? (descEl.textContent || '').trim() : '';
        
        // 找标题
        var ogTitle = document.querySelector('meta[property=\"og:title\"]');
        var titleEl = document.querySelector('title');
        var title = ogTitle?.content || (titleEl ? titleEl.textContent.replace(' - 小红书', '') : '');
        
        // 找封面图
        var ogImage = document.querySelector('meta[property=\"og:image\"]');
        var cover = ogImage?.content || '';
        
        // 找作者 - 通常在左侧个人信息区域
        var authorEl = document.querySelector('[class*=username], [class*=author-name], [class*=nickname]');
        var author = authorEl ? authorEl.textContent.trim() : '';
        
        // 互动数据 - 通常在底部
        var likeEl = document.querySelector('[class*=like-wrapper] [class*=count], [class*=like-count]');
        var likes = likeEl ? parseInt(likeEl.textContent.replace(/[^0-9]/g, '')) || 0 : 0;
        
        return {
          hasDesc: descText.length > 10,
          title: title,
          desc: descText,
          cover: cover,
          author: author,
          likes: likes,
          descLen: descText.length,
        };
      })()`);
      
      if (noteData && noteData.hasDesc) {
        console.error(`  ✅ 正文已加载: ${noteData.descLen} 字`);
        break;
      }
    }

    if (!noteData || !noteData.hasDesc) {
      // 降级 - 只返回标题和封面
      console.error('  正文未加载完成，返回基础信息');
      const fallback = await cdp.eval(`(() => {
        var ogTitle = document.querySelector('meta[property=\"og:title\"]');
        var ogImage = document.querySelector('meta[property=\"og:image\"]');
        var titleEl = document.querySelector('title');
        return {
          title: ogTitle?.content || (titleEl ? titleEl.textContent.replace(' - 小红书', '') : ''),
          cover: ogImage?.content || '',
        };
      })()`);
      return { ok: true, note_id: noteId, ...(fallback || {}), desc: '', tags: [], images: [], _note: '正文未加载，可能是需要登录' };
    }

    // 5. 尝试提取互动数据和标签
    const extras = await cdp.eval(`(() => {
      var result = {};
      
      // 互动数据
      var counts = document.querySelectorAll('[class*=count]');
      var likes = 0, collects = 0, comments = 0;
      counts.forEach(function(el) {
        var txt = (el.textContent || '').trim();
        var num = parseInt(txt.replace(/[^0-9]/g, '')) || 0;
        if (txt.includes('赞') || txt.includes('like')) likes = num;
        else if (txt.includes('藏') || txt.includes('collect')) collects = num;
        else if (txt.includes('评') || txt.includes('comment')) comments = num;
        // heuristic: first number is likes
        if (!likes && num > 0) likes = num;
      });
      result.likes = likes;
      result.collects = collects;
      result.comments = comments;
      
      // 标签
      var tagEls = document.querySelectorAll('[class*=tag]');
      var tags = [];
      tagEls.forEach(function(el) {
        var t = (el.textContent || '').trim();
        if (t && t.startsWith('#')) tags.push(t);
      });
      result.tags = tags;
      
      // 作者
      var authorEl = document.querySelector('[class*=username], [class*=author-name], [class*=nickname]');
      result.author = authorEl ? authorEl.textContent.trim() : '';
      
      return result;
    })()`);

    return {
      ok: true,
      source: 'browser_dom',
      note_id: noteId,
      title: noteData.title || '',
      desc: noteData.desc || '',
      author: extras?.author || noteData.author || '',
      author_id: '',
      likes: extras?.likes || noteData.likes || 0,
      collects: extras?.collects || 0,
      comments: extras?.comments || 0,
      shares: 0,
      tags: extras?.tags || [],
      images: [],
      cover: noteData.cover || '',
      type: '',
    };
  } finally {
    if (cdp) { try { cdp.close(); } catch (e) {} }
    try { await proxyCloseAll(scope); } catch (e) {}
  }
}

// ─── 搜索 + 详情
// ─── 搜索 + 详情 ──────────────────────────────────────────────

async function searchWithDetails(keyword, options = {}) {
  const { maxResults = 3, ...searchOptions } = options;

  // 规范：获取详情时默认只搜图文笔记，避开视频内容
  if (!options.noteType || options.noteType === 'all') {
    searchOptions.noteType = 'image';
    console.error(`[搜索+详情] 自动切换到图文模式(--note-type image)，避开视频笔记`);
  }

  console.error(`[搜索+详情] 关键词: "${keyword}"  最多获取 ${maxResults} 篇详情`);

  const S = 'xhs-detail-' + Date.now();
  const scope = resolveAgentScope('xhs-with-detail');

  try {
    const sortParam = SORT_OPTIONS[searchOptions.sort || 'general'] || 'general';
    const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&sort=${sortParam}`;
    const newResult = await proxyNew(searchUrl, scope);
    const targetId = newResult.targetId;
    if (!targetId) return { ok: false, error: '无法创建页面' };

    await sleep(5000);

    // 连接 CDP
    const pages = await (await fetch(CDP_BASE + '/json/list')).json();
    const page = pages.find(p => p.id === targetId) || pages[pages.length - 1];
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let mid = 1, pending = new Map();
    ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    await new Promise(r => ws.on('open', r));

    const sendCdp = (method, params) => new Promise(r => { const id = mid++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async (expr) => { const r = await sendCdp('Runtime.evaluate', { expression: expr, returnByValue: true }); return r?.result?.result?.value; };

    // 打开筛选面板进行排序和类型筛选
    if (sortParam !== 'general' || searchOptions.noteType !== 'all') {
      await sleep(2000);
      await ev(`(() => { var b = document.querySelector('div.filter'); if(b) { b.click(); return true; } return false; })()`);
      await sleep(1500);
      if (sortParam !== 'general') {
        const label = { 'time_descending': '最新', 'popularity_descending': '最多点赞', 'comment_descending': '最多评论', 'collect_descending': '最多收藏' }[sortParam];
        if (label) await ev(`(() => { var tags = document.querySelectorAll('div.tags'); for(var i=0;i<tags.length;i++){ if((tags[i].textContent||'').trim()==='${label}'){ tags[i].click(); return true; } } return false; })()`);
        await sleep(500);
      }
      if (searchOptions.noteType === 'image') {
        await ev(`(() => { var tags = document.querySelectorAll('div.tags'); var found=[]; for(var i=0;i<tags.length;i++){ if((tags[i].textContent||'').trim()==='图文') found.push(tags[i]); } var t=found.length>0?found[found.length-1]:null; if(t){t.click();return true} return false; })()`);
        console.error('  ✅ 已筛选图文笔记');
        await sleep(500);
      }
      await ev(`(() => { var ops = document.querySelectorAll('div.operation'); for(var i=0;i<ops.length;i++){ if((ops[i].textContent||'').trim()==='收起'){ ops[i].click(); return true; } } return false; })()`);
      await sleep(3000);
    }

    // 等待笔记渲染
    let noteCount = 0;
    for (let w = 0; w < 15; w++) {
      await sleep(1500);
      const c = await ev('document.querySelectorAll("section.note-item").length');
      if (c > 0) { noteCount = c; break; }
    }
    console.error(`  📄 ${noteCount} 条笔记 (图文模式)`);
    if (noteCount === 0) return { ok: false, error: '搜索无结果' };

    // 提取卡片信息
    const cardsInfo = await ev(`(function(){
      var items = document.querySelectorAll("section.note-item");
      return Array.from(items).slice(0, ${maxResults * 2}).map(function(item){
        var r = item.getBoundingClientRect();
        var links = item.querySelectorAll("a");
        var noteId = "";
        for (var i = 0; i < links.length; i++) {
          var m = (links[i].getAttribute("href") || "").match(/\\/explore\\/([^?/]+)/);
          if (m) { noteId = m[1]; break; }
        }
        var coverImg = item.querySelector("a.cover img");
        var cover = coverImg ? coverImg.src : "";
        var titleSpan = item.querySelector("a.title span");
        var title = titleSpan ? titleSpan.textContent.trim() : "";
        var authorEl = item.querySelector("div.name");
        var author = authorEl ? authorEl.textContent.trim() : "";
        return {
          note_id: noteId, title: title || "(无标题)", author: author,
          cover: cover, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)
        };
      }).filter(function(n){ return n.note_id && n.title && n.title !== "(无标题)"; });
    })()`);

    const notesToDetail = (cardsInfo || []).slice(0, maxResults);
    console.error(`  🎯 将获取 ${notesToDetail.length} 篇详情`);

    // 逐一点击卡片提取详情
    const results = [];
    for (let i = 0; i < notesToDetail.length; i++) {
      const card = notesToDetail[i];
      console.error(`  [${i+1}/${notesToDetail.length}] ${card.title.slice(0, 25)}`);

      await sendCdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: card.x, y: card.y, button: 'left', clickCount: 1 });
      await sendCdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: card.x, y: card.y, button: 'left', clickCount: 1 });

      let detail = null;
      for (let w = 0; w < 10; w++) {
        await sleep(1000);
        detail = await ev(`(function(){
          var mask = document.querySelector("[class*=note-detail-mask]");
          if (!mask) return null;
          var text = (mask.textContent || "").trim().replace(/\\s+/g, " ").trim();
          if (text.length < 80) return null;
          var lines = text.split(/\\s+/).filter(Boolean);
          var endIdx = lines.findIndex(function(l, idx){ return idx > 3 && (l.includes('评论') || l.includes('回复') || l.match(/^\\d{2}-\\d{2}/)); });
          var desc = endIdx > 0 ? lines.slice(2, endIdx).join(' ') : lines.slice(2, 30).join(' ');
          return { desc: desc.slice(0, 1000) };
        })()`);
        if (detail && detail.desc && detail.desc.length > 10) {
          console.error(`    ✅ ${detail.desc.length}字`);
          break;
        }
      }
      results.push({ ...card, desc: detail ? detail.desc : '' });

      if (i < notesToDetail.length - 1) {
        // 随机等待再操作下一篇
        await randomSleep(2000, 4000);
        await sendCdp('Page.navigate', { url: searchUrl });
        await randomSleep(5000, 8000);
        for (let w = 0; w < 10; w++) {
          await sleep(1500);
          const c = await ev('document.querySelectorAll("section.note-item").length');
          if (c > 0) {
            const newPos = await ev(`(function(){
              var items = document.querySelectorAll("section.note-item");
              for(var idx=0;idx<items.length;idx++){
                var links = items[idx].querySelectorAll("a");
                for(var j=0;j<links.length;j++){
                  if((links[j].getAttribute("href")||"").includes("${notesToDetail[i+1].note_id}")){
                    var r = items[idx].getBoundingClientRect();
                    return JSON.parse(JSON.stringify({x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2)}));
                  }
                }
              }
              return null;
            })()`);
            if (newPos) { notesToDetail[i+1].x = newPos.x; notesToDetail[i+1].y = newPos.y; }
            break;
          }
        }
      }
    }

    ws.close();
    return {
      ok: true, keyword, sort: sortParam, noteType: 'image', page: 1,
      total: results.length, resultCount: results.length, results,
      source: 'browser_dom_popup', withDetail: true,
    };
  } finally {
    await proxyCloseAll(scope);
  }
}

// ─── enrich: 从已保存的搜索结果中提取详情 ──────────────────

async function enrichResults(savedFilePath, options = {}) {
  const { maxResults = 20 } = options;

  // 1. 读取保存的搜索结果
  let searchData;
  try {
    const raw = readFileSync(resolve(SKILL_DIR, savedFilePath), 'utf-8');
    searchData = JSON.parse(raw);
  } catch(e) {
    // 尝试直接路径
    try {
      const raw = readFileSync(savedFilePath, 'utf-8');
      searchData = JSON.parse(raw);
    } catch(e2) {
      return { ok: false, error: '无法读取搜索结果文件: ' + e2.message };
    }
  }

  const keyword = searchData.keyword;
  const sortParam = searchData.sort || 'general';
  const notes = (searchData.results || []).filter(n => n.title && n.title !== '(无标题)').slice(0, maxResults);

  console.error(`[提取详情] 从 ${basename(savedFilePath)} 读取 ${notes.length} 篇笔记`);

  if (notes.length === 0) return { ok: false, error: '搜索结果中没有有效笔记' };

  // 2. 打开搜索页面
  const scope = resolveAgentScope('xhs-enrich');
  try {
    const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`;
    const newResult = await proxyNew(searchUrl, scope);
    const targetId = newResult.targetId;
    if (!targetId) return { ok: false, error: '无法创建页面' };

    await sleep(5000);

    // 3. 连接 CDP
    const pages = await (await fetch(CDP_BASE + '/json/list')).json();
    const page = pages.find(p => p.id === targetId) || pages[pages.length - 1];
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let mid = 1, pending = new Map();
    ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    await new Promise(r => ws.on('open', r));

    const sendCdp = (method, params) => new Promise(r => { const id = mid++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async (expr) => { const r = await sendCdp('Runtime.evaluate', { expression: expr, returnByValue: true }); return r?.result?.result?.value; };

    // 4. 筛选图文笔记
    await sleep(2000);
    await ev(`(() => { var b = document.querySelector('div.filter'); if(b) { b.click(); return true; } return false; })()`);
    await sleep(1500);
    await ev(`(() => { var tags = document.querySelectorAll('div.tags'); var found=[]; for(var i=0;i<tags.length;i++){ if((tags[i].textContent||'').trim()==='图文') found.push(tags[i]); } var t=found.length>0?found[found.length-1]:null; if(t){t.click();return true} return false; })()`);
    await sleep(500);
    await ev(`(() => { var ops = document.querySelectorAll('div.operation'); for(var i=0;i<ops.length;i++){ if((ops[i].textContent||'').trim()==='收起'){ ops[i].click(); return true; } } return false; })()`);
    await sleep(3000);

    // 5. 等笔记渲染
    for (let w = 0; w < 15; w++) {
      await sleep(1500);
      if (await ev('document.querySelectorAll("section.note-item").length') > 0) break;
    }

    // 6. 逐一点击提取
    const enriched = [];
    for (let i = 0; i < notes.length; i++) {
      const note = notes[i];
      console.error(`  [${i+1}/${notes.length}] ${note.title.slice(0, 25)}`);

      // 找到卡片位置
      let pos = await ev(`(function(){
        var items = document.querySelectorAll("section.note-item");
        for(var idx=0;idx<items.length;idx++){
          var links = items[idx].querySelectorAll("a");
          for(var j=0;j<links.length;j++){
            if((links[j].getAttribute("href")||"").includes("${note.note_id}")){
              var r = items[idx].getBoundingClientRect();
              return JSON.parse(JSON.stringify({x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2)}));
            }
          }
        }
        return null;
      })()`);

      if (!pos) {
        // Fallback: 按索引位置点击
        console.error('    ⚠️ 找不到卡片，按索引点击...');
        const fallbackPos = await ev(`(function(){
          var items = document.querySelectorAll("section.note-item");
          if (items.length > ${i}) {
            var r = items[${i}].getBoundingClientRect();
            return JSON.parse(JSON.stringify({x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2)}));
          }
          return null;
        })()`);
        if (fallbackPos) { pos = fallbackPos; }
        else {
          console.error('    ⚠️ 找不到卡片');
          enriched.push({ ...note, desc: '' });
          continue;
        }
      }

      await sendCdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      await sendCdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });

      let detail = null;
      for (let w = 0; w < 10; w++) {
        await sleep(1000);
        detail = await ev(`(function(){
          var mask = document.querySelector("[class*=note-detail-mask]");
          if (!mask) return null;
          var text = (mask.textContent || "").trim().replace(/\\s+/g, " ").trim();
          if (text.length < 80) return null;
          var lines = text.split(/\\s+/).filter(Boolean);
          var endIdx = lines.findIndex(function(l, idx){ return idx > 3 && (l.includes('评论') || l.includes('回复') || l.match(/^\\d{2}-\\d{2}/)); });
          var desc = endIdx > 0 ? lines.slice(2, endIdx).join(' ') : lines.slice(2, 30).join(' ');
          return { desc: desc.slice(0, 1000) };
        })()`);
        if (detail && detail.desc && detail.desc.length > 10) {
          console.error(`    ✅ ${detail.desc.length}字`);
          break;
        }
      }

      enriched.push({ ...note, desc: detail ? detail.desc : '' });

      if (i < notes.length - 1) {
        await randomSleep(2000, 4000);
        await sendCdp('Page.navigate', { url: searchUrl });
        await randomSleep(5000, 8000);
        for (let w = 0; w < 10; w++) {
          await sleep(1500);
          if (await ev('document.querySelectorAll("section.note-item").length') > 0) break;
        }
      }
    }

    ws.close();

    // 7. 保存结果
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = resolve(SKILL_DIR, `xhs-enriched-${keyword.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_').slice(0, 20)}-${ts}.json`);
    const output = { originalFile: savedFilePath, keyword, enrichedCount: enriched.length, results: enriched };
    writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
    console.error(`\n✅ 提取完成，已保存到: ${outPath}`);
    return { ok: true, file: outPath, count: enriched.length, results: enriched };
  } finally {
    await proxyCloseAll(scope);
  }
}

// ─── 输出格式化 ──────────────────────────────────────────────

function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

function printMarkdown(result) {
  const results = result.results || [];
  console.log(`# 小红书搜索结果\n`);
  console.log(`**关键词**: ${result.keyword}  **排序**: ${result.sort}  **页码**: ${result.page}`);
  console.log(`**共 ${result.total} 条结果**\n`);

  results.forEach((note, i) => {
    console.log(`---\n`);
    console.log(`### ${i + 1}. ${note.title}`);
    console.log(``);
    if (note.author) console.log(`**作者**: ${note.author}`);
    console.log(`**链接**: ${note.url}`);
    console.log(``);

    if (note.detail) {
      const d = note.detail;
      if (d.desc) {
        console.log(`**正文**:`);
        console.log(`${d.desc.replace(/\\n/g, '\n> ')}`);
        console.log(``);
      }
      if (d.likes) console.log(`**互动**: 👍 ${d.likes}  💾 ${d.collects}  💬 ${d.comments}`);
      if (d.tags?.length) console.log(`**标签**: ${d.tags.join(' / ')}`);
      if (d.images?.length) {
        console.log(`**图片**: ${d.images.length} 张`);
      }
      console.log(``);
    } else {
      if (note.cover) console.log(`![封面](${note.cover})`);
      console.log(``);
    }
  });
}

// ─── CLI ──────────────────────────────────────────────────────

function printUsage() {
  console.log(`
小红书搜索工具 v1.0

用法:
  node xhs-search.mjs search --keyword "关键词" [选项]
  node xhs-search.mjs detail --note-id "笔记ID"
  node xhs-search.mjs search --keyword "关键词" --with-detail --max-results 3

搜索选项:
  --keyword  KEYWORD       搜索关键词（必填）
  --sort     SORT          排序 (general|time_descending|popularity_descending|
                           comment_descending|collect_descending, 默认 general)
  --page     PAGE          页码（默认 1）
  --page-size SIZE         每页条数（默认 20）
  --with-detail            同时获取笔记详情（自动切换图文模式，点击卡片弹窗提取正文）
  --max-results N          最多获取 N 篇详情（默认 3）
  --note-type TYPE         笔记类型 (all|video|image, 默认 all)
  --format   FORMAT        输出格式 (json|markdown, 默认 json)
  --save                   保存结果到文件
  --history                查看搜索历史

增强命令:
  enrich --from FILE [--max N]    从已保存的搜索结果中提取详情（分步收集法）

笔记详情选项:
  --note-id  ID            笔记 ID
  --format   FORMAT        输出格式 (json|markdown, 默认 json)

示例:
  node xhs-search.mjs search --keyword "AI工具"
  node xhs-search.mjs search --keyword "AI工具" --sort time_descending
  node xhs-search.mjs search --keyword "旅游攻略" --with-detail --max-results 5
  node xhs-search.mjs detail --note-id "69c260a90000000021010226"
  `.trim());
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage();
    return;
  }

  const command = args[0];
  const params = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (arg === '--with-detail' || arg === '--save' || arg === '--history') {
        params[key] = true;
      } else {
        params[key] = args[++i];
      }
    }
  }

  let result;

  switch (command) {
    case 'search': {
      // --history 标志：显示搜索历史
      if (params.history) {
        const historyPath = resolve(SKILL_DIR, 'search-history.json');
        let history = [];
        try {
          const raw = readFileSync(historyPath, 'utf-8');
          history = JSON.parse(raw);
        } catch(e) {}
        result = { ok: true, total: history.length, entries: history.slice(0, 20) };
        break;
      }
      if (!params.keyword) {
        console.error('错误: 请使用 --keyword 指定搜索关键词');
        process.exit(1);
      }
      const searchOptions = {
        sort: params.sort || 'general',
        page: parseInt(params.page || '1', 10),
        pageSize: parseInt(params.pageSize || '20', 10),
        noteType: params.noteType || 'all',
      };
      if (params.withdetail || params.withDetail) {
        result = await searchWithDetails(params.keyword, {
          ...searchOptions,
          maxResults: parseInt(params.maxResults || '3', 10),
        });
      } else {
        result = await searchNotes(params.keyword, searchOptions);
      }
      // 保存结果到文件
      if (params.save) {
        try {
          const fmt = params.format || 'json';
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const safeName = params.keyword.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_').slice(0, 30);
          const fileName = 'xhs-search-' + safeName + '-' + ts + '.' + fmt;
          const filePath = resolve(SKILL_DIR, fileName);
          let output;
          if (fmt === 'markdown') {
            const lines = [];
            const oldLog = console.log;
            console.log = function(...args) { lines.push(args.join(' ')); };
            printMarkdown(result);
            console.log = oldLog;
            output = lines.join('\n');
          } else {
            output = JSON.stringify(result, null, 2);
          }
          writeFileSync(filePath, output, 'utf-8');
          result._savedTo = filePath;
          console.error('  结果已保存到: ' + filePath);
        } catch(e) { console.error('  保存失败:', e.message); }
      }
      break;
    }

    case 'enrich': {
      if (!params.from) {
        console.error('错误: 请使用 --from 指定搜索结果文件');
        process.exit(1);
      }
      result = await enrichResults(params.from, {
        maxResults: parseInt(params.max || params.maxResults || '20', 10),
      });
      break;
    }

    case 'detail': {
      if (!params.noteId) {
        console.error('错误: 请使用 --note-id 指定笔记 ID');
        process.exit(1);
      }
      result = await getNoteDetail(params.noteId);
      break;
    }

    default:
      console.error(`错误: 未知命令 "${command}"`);
      printUsage();
      process.exit(1);
  }

  const format = params.format || 'json';
  if (format === 'markdown') {
    printMarkdown(result);
  } else {
    printJson(result);
  }
}

main().catch(err => {
  console.error('脚本错误:', err.message);
  process.exit(1);
});
