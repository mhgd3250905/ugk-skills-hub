#!/usr/bin/env node
/**
 * 小红书关键词检索 - 标准版
 * 
 * 一站式：搜关键词 → 图文模式 → 前20条 → 点卡片弹窗取详情 → 分析整合报告
 * 
 * 关键设计：一次搜索页面打开后，逐一点击卡片弹窗 → 关弹窗 → 点下一个
 * 不反复刷新搜索页面，不反复导航
 *
 * 用法: node xhs-standard-search.mjs --keyword "当阳美食"
 */

import WebSocket from '/app/node_modules/ws/lib/websocket.js';
import fs from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(__dirname, '..');
const CDP_BASE = 'http://172.31.250.10:9223';
const PROXY_BASE = 'http://127.0.0.1:3456';

const SCOPE_ENV_NAMES = ['CLAUDE_AGENT_ID', 'CLAUDE_HOOK_AGENT_ID', 'agent_id'];
function resolveScope() {
  for (const n of SCOPE_ENV_NAMES) { const v = (process.env[n] || '').trim(); if (v) return v; }
  return 'xhs-std-' + Date.now();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomSleep(min, max) { return new Promise(r => setTimeout(r, min + Math.floor(Math.random() * (max - min + 1)))); }

// ─── 浏览器工具 ────────────────────────────────────────────────

async function openPage(url, scope) {
  const r = await (await fetch(PROXY_BASE + '/new?url=' + encodeURIComponent(url) + '&metaAgentScope=' + scope)).json();
  return r.targetId;
}

async function connectCdp(targetId) {
  const pages = await (await fetch(CDP_BASE + '/json/list')).json();
  const p = pages.find(p => p.id === targetId) || pages[pages.length - 1];
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  let mid = 1, pd = new Map();
  ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && pd.has(m.id)) { pd.get(m.id)(m); pd.delete(m.id); } });
  await new Promise(r => ws.on('open', r));
  const sendCdp = (method, params) => new Promise(r => { const id = mid++; pd.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  return {
    send: sendCdp,
    eval: async (expr) => { const r = await sendCdp('Runtime.evaluate', { expression: expr, returnByValue: true }); return r?.result?.result?.value; },
    click: async (x, y) => {
      await sendCdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await sendCdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },
    close: () => ws.close()
  };
}

// ─── Phase 1+2: 收集 + 提取（同一页面）───────────────────

async function collectAndExtract(keyword, targetCount) {
  const scope = resolveScope();
  console.error(`\n═══════════════════════════════════════`);
  console.error(`  Phase 1: 搜索 + 筛选图文`);
  console.error(`═══════════════════════════════════════\n`);

  // 打开搜索页面
  const searchUrl = 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(keyword);
  const tid = await openPage(searchUrl, scope);
  await sleep(5000);
  const cdp = await connectCdp(tid);

  // 筛选图文
  console.error('  📋 筛选图文笔记...');
  await randomSleep(2000, 3000);
  await cdp.eval("(() => { var b = document.querySelector('div.filter'); if(b) { b.click(); return true; } return false; })()");
  await randomSleep(1000, 2000);
  await cdp.eval("(() => { var tags = document.querySelectorAll('div.tags'); var found = []; for(var i=0;i<tags.length;i++){ if((tags[i].textContent||'').trim()==='图文') found.push(tags[i]); } var t = found.length > 0 ? found[found.length-1] : null; if(t){ t.click(); return true; } return false; })()");
  await sleep(500);
  // 关闭筛选面板：再点一次 div.filter 切换关闭，或者点页面空白处
  await cdp.eval("(() => { var b = document.querySelector('div.filter'); if(b) { b.click(); return true; } return false; })()");
  await sleep(1000);
  // 确认 tag-container 不再遮挡卡片（点击页面左上角空白处确保面板收起）
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 10, button: 'left', clickCount: 1 });
  console.error('  ✅ 图文筛选完成');
  await randomSleep(3000, 4000);

  // 等待笔记渲染+滚动
  let noteCount = 0;
  for (let w = 0; w < 20; w++) { await sleep(1500); const c = await cdp.eval('document.querySelectorAll("section.note-item").length'); if (c > 0) { noteCount = c; break; } }
  console.error(`  📄 初次加载 ${noteCount} 条`);

  for (let s = 0; s < 4 && noteCount < targetCount; s++) {
    await cdp.eval('window.scrollTo(0, document.body.scrollHeight);');
    await randomSleep(2000, 3500);
    for (let w = 0; w < 8; w++) { await randomSleep(1000, 2000); const c = await cdp.eval('document.querySelectorAll("section.note-item").length'); if (c > noteCount) { noteCount = c; break; } }
    console.error(`  滚动 ${s+1}: ${noteCount} 条`);
  }

  // 提取笔记卡片信息
  const notes = await cdp.eval(`(function(){
    var items = document.querySelectorAll("section.note-item");
    var result = [];
    for (var idx = 0; idx < items.length && result.length < ${targetCount}; idx++) {
      var item = items[idx];
      var r = item.getBoundingClientRect();
      var links = item.querySelectorAll("a");
      var noteId = "";
      for (var i = 0; i < links.length; i++) {
        var m = (links[i].getAttribute("href") || "").match(/\\/explore\\/([^?/]+)/);
        if (m) { noteId = m[1]; break; }
      }
      var titleSpan = item.querySelector("a.title span");
      var title = titleSpan ? titleSpan.textContent.trim() : "";
      var authorEl = item.querySelector("div.name");
      var author = authorEl ? authorEl.textContent.trim() : "";
      var coverImg = item.querySelector("a.cover img");
      var cover = coverImg ? coverImg.src : "";
      if (noteId) {
        result.push({ note_id: noteId, title: title || '(无标题)', author: author, cover: cover, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
      }
    }
    return result;
  })()`);

  const valid = notes || [];
  console.error(`  📥 有效笔记 ${valid.length} 篇`);
  if (valid.length === 0) { cdp.close(); throw new Error('未找到有效笔记'); }

  // ── Phase 2: 提取详情（同一页面，逐一点击弹窗）──
  console.error(`\n═══════════════════════════════════════`);
  console.error(`  Phase 2: 点击卡片弹窗提取详情`);
  console.error(`═══════════════════════════════════════\n`);

  const enriched = [];
  for (let i = 0; i < valid.length; i++) {
    const note = valid[i];
    process.stderr.write(`  [${i+1}/${valid.length}] ${note.title.slice(0, 25)} `);

    // 先把卡片滚到视口内
    await cdp.eval(`window.scrollTo(0, Math.max(0, ${note.y} - 300));`);
    await sleep(800);

    // 重新获取卡片最新的视口坐标
    const currentPos = await cdp.eval(`(function(){
      var items = document.querySelectorAll("section.note-item");
      for(var idx=0;idx<items.length;idx++){
        var links = items[idx].querySelectorAll("a");
        for(var j=0;j<links.length;j++){
          if((links[j].getAttribute("href")||"").includes("${note.note_id}")){
            var r = items[idx].getBoundingClientRect();
            return {x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2)};
          }
        }
      }
      return null;
    })()`);

    const baseX = currentPos ? currentPos.x : note.x;
    const baseY = currentPos ? currentPos.y : note.y;

    // 带重试：如果 3 秒内没弹窗，换个位置再试
    let detail = null;
    const clickOffsets = [
      { x: baseX, y: baseY },           // 卡片中心
      { x: baseX - 50, y: baseY },       // 左偏 50
      { x: baseX, y: baseY + 20 },       // 微下
      { x: baseX - 80, y: baseY - 10 },  // 左上
      { x: baseX - 30, y: baseY + 50 },  // 左下
    ];
    
    for (let attempt = 0; attempt < clickOffsets.length; attempt++) {
      await cdp.click(clickOffsets[attempt].x, clickOffsets[attempt].y);

      // 等弹窗出现（最多 3 秒检查一次）
      let popupAppeared = false;
      for (let w = 0; w < 3; w++) {
        await sleep(1000);
        const hasMask = await cdp.eval(`(function(){
          var mask = document.querySelector("[class*=note-detail-mask]");
          return mask ? (mask.textContent || '').trim().length : 0;
        })()`);
        if (hasMask > 0) { popupAppeared = true; break; }
      }
      
      if (!popupAppeared) {
        // 没弹窗，关掉可能误触的残余弹窗再试下一个位置
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 27, key: 'Escape' });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape' });
        await sleep(500);
        continue;
      }

      // 弹窗出现了，提取正文
      for (let w = 0; w < 10; w++) {
        await sleep(1000);
        detail = await cdp.eval(`(function(){
          var mask = document.querySelector("[class*=note-detail-mask]");
          if (!mask) return null;
          var text = (mask.textContent || "").trim().replace(/\\s+/g, " ").trim();
          if (text.length < 10) return null;
          var lines = text.split(/\\s+/).filter(Boolean);
          var endIdx = lines.findIndex(function(l, idx){ return idx > 3 && (l.includes('评论') || l.includes('回复') || l.match(/^\\d{2}-\\d{2}/)); });
          var desc = endIdx > 0 ? lines.slice(2, endIdx).join(' ') : lines.slice(2, 30).join(' ');
          return { desc: desc.slice(0, 1000) };
        })()`);
        if (detail && detail.desc && detail.desc.length > 10) {
          // 防串号：如果内容和上一条完全一样，说明弹窗没切换
          if (i > 0 && enriched[i-1] && enriched[i-1].desc === detail.desc) {
            process.stderr.write(`↺`);
            detail = null;
            // 关掉这个残留弹窗
            await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 27, key: 'Escape' });
            await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape' });
            await sleep(800);
            break; // 退出本轮等待，让外层 retry 逻辑重新点击
          }
          break;
        }
      }
      
      if (detail) break; // 成功提取，跳出重试循环
    }

    if (detail) {
      process.stderr.write(`✅ ${detail.desc.length}字\n`);
      enriched.push({ ...note, desc: detail.desc });
    } else {
      process.stderr.write(`⚠️ 无正文\n`);
      enriched.push({ ...note, desc: '' });
    }

    // 关弹窗，准备点下一篇
    if (i < valid.length - 1) {
      // 按 Escape 关弹窗，最多尝试 3 次
      for (let closeAttempt = 0; closeAttempt < 3; closeAttempt++) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 27, key: 'Escape' });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape' });
        await sleep(600);
        
        const stillOpen = await cdp.eval(`(function(){
          return document.querySelector("[class*=note-detail-mask]") ? true : false;
        })()`);
        
        if (!stillOpen) break;
      }
      
      // 如果弹窗还在（Escape 失效），点页面空白处关闭
      const stillOpen2 = await cdp.eval(`(function(){
        return document.querySelector("[class*=note-detail-mask]") ? true : false;
      })()`);
      if (stillOpen2) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10, button: 'left', clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 10, button: 'left', clickCount: 1 });
        await sleep(800);
      }
      
      await sleep(500);
    }
  }

  cdp.close();
  return enriched;
}

// ─── Phase 3: 分析整合 ──────────────────────────────────────

function analyze(keyword, enriched) {
  console.error(`\n═══════════════════════════════════════`);
  console.error(`  Phase 3: 分析整合`);
  console.error(`═══════════════════════════════════════\n`);

  const valid = enriched.filter(n => n.desc && n.desc.length > 10);
  console.error(`  ${enriched.length} 篇中 ${valid.length} 篇有正文\n`);

  let md = `# ${keyword} - 小红书关键词检索报告\n\n`;
  md += `> 📅 生成时间：${new Date().toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'})}\n`;
  md += `> 📊 共检索 ${enriched.length} 篇图文笔记，${valid.length} 篇有正文内容\n`;
  md += `> 🔍 来源：小红书搜索结果（图文模式，综合排序）\n\n`;
  md += `---\n\n`;

  enriched.forEach((n, i) => {
    md += `## ${i + 1}. ${n.title}\n\n`;
    md += `**👤 作者**：${n.author || '未知'}\n\n`;
    if (n.desc) {
      md += '**📝 正文**：\n\n';
      const sentences = n.desc.split(/(?<=[。！？.!?])\s*/).filter(Boolean);
      sentences.forEach(s => { s = s.trim(); if (s.length > 5) md += s + '\n\n'; });
    }
    if (n.cover) md += `![封面](${n.cover})\n\n`;
    md += '---\n\n';
  });

  md += '\n*📌 报告由小红书关键词检索标准版自动生成*';
  return md;
}

// ─── 主入口 ──────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let keyword = '';
  let targetCount = 20;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--keyword') keyword = args[++i];
    else if (args[i] === '--max') targetCount = parseInt(args[++i]) || 20;
    else if (args[i] === '--help') {
      process.stderr.write(`\n小红书关键词检索 - 标准版\n\n用法:\n  node xhs-standard-search.mjs --keyword "关键词" [--max 条数]\n\n示例:\n  node xhs-standard-search.mjs --keyword "当阳美食"\n  node xhs-standard-search.mjs --keyword "旅游攻略" --max 30\n`);
      process.exit(0);
    }
  }

  if (!keyword) { console.error('错误: 请使用 --keyword'); process.exit(1); }

  process.stderr.write(`\n📌 小红书标准检索: "${keyword}"\n`);
  process.stderr.write(`   图文模式 · 前 ${targetCount} 条 · 综合排序\n`);

  // Phase 1 + 2
  const enriched = await collectAndExtract(keyword, targetCount);

  // Phase 3
  const report = analyze(keyword, enriched);

  // 保存
  const safeName = keyword.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_').slice(0, 20);
  const filePath = resolve(SKILL_DIR, `${safeName}-检索报告.md`);
  fs.writeFileSync(filePath, report, 'utf-8');
  process.stderr.write(`\n📄 报告已保存: ${filePath}\n\n`);

  console.log(report);
}

main().catch(e => {
  console.error('❌ 错误:', e.message);
  process.exit(1);
});
