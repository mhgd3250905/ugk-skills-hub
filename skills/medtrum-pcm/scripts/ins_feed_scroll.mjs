#!/usr/bin/env node
import process from 'node:process';
import { ensureHostBrowserBridge, requestHostBrowser } from '../../web-access/scripts/host-bridge.mjs';
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function cmd(action, meta = {}) { const r = await requestHostBrowser(action, { timeoutMs: 45000, meta }); if (!r?.ok) throw new Error(r?.error); return r; }
async function evaluate(targetId, expr, meta) { const r = await cmd({ action: 'evaluate', targetId, expression: expr }, meta); return r?.value; }
async function scrollDown(targetId, y) { await cmd({ action: 'scroll', targetId, y }); }

const EXTRACT = `(function(){var R=[],S={},A=document.querySelectorAll('article');for(var i=0;i<A.length;i++){var a=A[i],t=(a.innerText||'').trim();if(t.length<20)continue;var L=a.querySelectorAll('a[href]'),h='',u='';for(var j=0;j<L.length;j++){var x=L[j].getAttribute('href')||'';if(x.indexOf('/p/')>=0||x.indexOf('/reel/')>=0)h='https://www.instagram.com'+(x[0]==='/'?x:'/'+x);else if(!u&&x.indexOf('/')===0&&x.length>2&&x.indexOf('/p/')<0&&x.indexOf('/reel/')<0)u=x.replace(/^\\//,'').replace(/\\/$/,'');}if(!h||S[h])continue;S[h]=1;R.push({text:t.slice(0,500),author:u,url:h});}return JSON.stringify(R);})()`;

// Click Like on medtrum/diabetes posts
const LIKE = "(function(){var s=document.querySelectorAll('article svg[aria-label=Like]');var liked=0;for(var i=0;i<s.length;i++){var a=s[i];while(a&&a.tagName!=='ARTICLE')a=a.parentElement;var t=((a||s[i]).innerText||'').toLowerCase();if(t.indexOf('medtrum')>=0||t.indexOf('diabetes')>=0){try{var span=s[i].parentElement;span.click();liked++;}catch(e){}}}return JSON.stringify({ok:true,liked:liked});})()";

async function main() {
  const MAX = parseInt(process.argv[2], 10) || 100;
  await ensureHostBrowserBridge();
  console.error('[ins] Opening...');
  const r = await cmd({ action: 'new_target', url: 'https://www.instagram.com/' });
  const tid = r.target.id;
  await sleep(5000);
  
  const pf = JSON.parse(await evaluate(tid, "(function(){var t=document.title||'';if(t.indexOf('login')>=0)return JSON.stringify({ok:false,error:'LOGIN'});return JSON.stringify({ok:true,title:t});})()"));
  if (!pf.ok) { console.error('INS_PF_FAIL:'+pf.error); process.exit(2); }
  console.error('[ins] PF OK');
  
  const all = [], seen = new Set();
  let sy = 0, nr = 0, liked = 0;
  
  for (let i = 0; i < 200 && all.length < MAX; i++) {
    const raw = await evaluate(tid, EXTRACT);
    let posts = []; try { posts = JSON.parse(raw); } catch(e) {}
    let nc = 0;
    for (const p of posts) { if (!p.url || seen.has(p.url)) continue; seen.add(p.url); all.push(p); nc++; }
    console.error('[ins] '+(i+1)+': +'+nc+' ='+all.length);
    nr = nc === 0 ? nr + 1 : 0;
    if (nr >= 5 || all.length >= MAX) break;
    
    try { const lr = JSON.parse(await evaluate(tid, LIKE)); liked += lr?.liked || 0; } catch(e) {}
    
    sy += 1000;
    await scrollDown(tid, sy);
    await sleep(1500);
  }
  
  console.error('[ins] Done: '+all.length+' posts, liked '+liked);
  console.log(JSON.stringify({
    platform: 'Instagram', keyword: 'feed-scroll', retrievedAt: new Date().toISOString(),
    preflight: pf, scrollNote: 'Liked '+liked+' medtrum/diabetes posts',
    total: all.length, dropped: 0,
    items: all.map(p => ({ date: '', author: p.author || '', content: (p.text||'').replace(/\\s+/g,' ').trim().slice(0,300), url: p.url||'' }))
  }, null, 2));
  
  await cmd({ action: 'close_target', targetId: tid });
}
main().catch(e => { console.error(e.message); process.exit(1); });
