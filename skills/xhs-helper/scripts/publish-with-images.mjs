#!/usr/bin/env node
/**
 * 小红书图片笔记发布脚本（最优路径）
 * 
 * 使用方式：
 *   node publish-with-images.mjs \
 *     --title "标题｜emoji" \
 *     --content "正文内容..." \
 *     --images img1.jpg,img2.jpg,img3.jpg
 * 
 * 图片路径：
 *   - 本地路径：先复制到 /app/.data/browser-upload/
 *   - CDP 使用：/config/upload/<filename>
 */

import WebSocket from '/app/node_modules/ws/lib/websocket.js';
import { readFileSync } from 'fs';

const CDP_BASE = 'http://172.31.250.10:9223';
const PROXY_BASE = 'http://127.0.0.1:3456';

// Scope env names matching browser-cleanup.ts and agent-run-scope.ts
const SCOPE_ENV_NAMES = ['CLAUDE_AGENT_ID', 'CLAUDE_HOOK_AGENT_ID', 'agent_id'];

function resolveAgentScope(defaultPrefix = 'xhs-publish') {
  for (const name of SCOPE_ENV_NAMES) {
    const val = (process.env[name] || '').trim();
    if (val) return val;
  }
  return `${defaultPrefix}-${Date.now()}`;
}

// 解析参数
function parseArgs() {
  const args = {
    title: '',
    content: '',
    images: [],
    scope: resolveAgentScope()
  };
  
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--title') {
      args.title = process.argv[++i];
    } else if (arg === '--content') {
      args.content = process.argv[++i];
    } else if (arg === '--content-file') {
      // 从文件读取内容
      args.content = readFileSync(process.argv[++i], 'utf-8');
    } else if (arg === '--images') {
      args.images = process.argv[++i].split(',').map(f => `/config/upload/${f}`);
    } else if (arg === '--scope') {
      args.scope = process.argv[++i];
    }
  }
  
  return args;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs();
  
  if (!args.title || !args.content || args.images.length === 0) {
    console.error('Usage: node publish-with-images.mjs --title "标题" --content "正文" --images img1.jpg,img2.jpg');
    console.error('\n图片需要先复制到 /app/.data/browser-upload/ 目录');
    process.exit(1);
  }
  
  console.log('=== 小红书图片发布 ===');
  console.log('标题:', args.title);
  console.log('图片数:', args.images.length);
  console.log('Scope:', args.scope);
  
  // ========== 步骤1: 用代理打开页面 ==========
  console.log('\n[1] 用代理打开页面...');
  const newResp = await fetch(`${PROXY_BASE}/new?url=https://creator.xiaohongshu.com/publish/publish?source=official&metaAgentScope=${args.scope}`);
  const newResult = await newResp.json();
  
  if (!newResult.targetId) {
    console.error('打开页面失败:', newResult);
    process.exit(1);
  }
  
  const TARGET_ID = newResult.targetId;
  console.log('TARGET_ID:', TARGET_ID);
  
  await sleep(4000);  // 等待页面加载
  
  // ========== 步骤2: 用 CDP WebSocket 完成所有操作 ==========
  console.log('\n[2] 连接 CDP WebSocket...');
  
  const pagesResp = await fetch(`${CDP_BASE}/json/list`);
  const pages = await pagesResp.json();
  const target = pages.find(p => p.id === TARGET_ID);
  
  if (!target) {
    console.error('找不到目标页面:', TARGET_ID);
    // 清理
    await fetch(`${PROXY_BASE}/close?target=${TARGET_ID}&metaAgentScope=${args.scope}`, { method: 'DELETE' });
    process.exit(1);
  }
  
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let messageId = 1;
  
  const sendCommand = (method, params = {}) => {
    return new Promise((resolve, reject) => {
      const id = messageId++;
      ws.send(JSON.stringify({ id, method, params }));
      
      const handler = (data) => {
        const resp = JSON.parse(data.toString());
        if (resp.id === id) {
          ws.off('message', handler);
          if (resp.error) reject(new Error(resp.error.message));
          else resolve(resp);
        }
      };
      ws.on('message', handler);
      setTimeout(() => reject(new Error('Timeout')), 30000);
    });
  };
  
  ws.on('error', async (err) => {
    console.error('WebSocket 错误:', err);
    await fetch(`${PROXY_BASE}/close?target=${TARGET_ID}&metaAgentScope=${args.scope}`, { method: 'DELETE' });
    process.exit(1);
  });
  
  ws.on('open', async () => {
    console.log('WebSocket 已连接');
    
    try {
      // ========== 步骤3: 点击"上传图文"切换模式 ==========
      console.log('\n[3] 切换到图文模式...');
      const switchResult = await sendCommand('Runtime.evaluate', {
        expression: `(() => {
          const el = Array.from(document.querySelectorAll('*')).find(e => e.textContent?.trim() === '上传图文');
          if (el) { el.click(); return 'clicked'; }
          return 'not found';
        })()`
      });
      console.log('切换结果:', switchResult.result?.result?.value);
      
      await sleep(2000);
      
      // ========== 步骤4: 上传图片 ==========
      console.log('\n[4] 上传图片...');
      
      // 获取 file input
      const doc = await sendCommand('DOM.getDocument', { depth: 0 });
      const queryResult = await sendCommand('DOM.querySelector', {
        nodeId: doc.result.root.nodeId,
        selector: 'input[type="file"][accept*="jpg"]'
      });
      
      if (!queryResult.result?.nodeId) {
        throw new Error('未找到图片上传 input，可能未切换到图文模式');
      }
      
      console.log('找到 file input, nodeId:', queryResult.result.nodeId);
      
      // 设置文件
      await sendCommand('DOM.setFileInputFiles', {
        nodeId: queryResult.result.nodeId,
        files: args.images
      });
      console.log('已设置图片:', args.images);
      
      // 触发 change 事件
      await sendCommand('Runtime.evaluate', {
        expression: `(() => {
          const input = document.querySelector('input[type="file"][accept*="jpg"]');
          if (input?.files?.length > 0) {
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return 'files: ' + input.files.length;
          }
          return 'no files';
        })()`
      });
      
      console.log('已触发 change 事件');
      
      await sleep(5000);  // 等待上传
      
      // ========== 步骤5: 填写标题 ==========
      console.log('\n[5] 填写标题...');
      const titleResult = await sendCommand('Runtime.evaluate', {
        expression: `(() => {
          const input = document.querySelector('input[placeholder*="标题"]') || document.querySelector('input[maxlength="20"]');
          if (input) {
            input.focus();
            input.value = ${JSON.stringify(args.title)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return 'filled: ' + input.value.substring(0, 20);
          }
          return 'not found';
        })()`
      });
      console.log('标题:', titleResult.result?.result?.value);
      
      await sleep(500);
      
      // ========== 步骤6: 填写正文 ==========
      console.log('\n[6] 填写正文...');
      const contentResult = await sendCommand('Runtime.evaluate', {
        expression: `(() => {
          const editor = document.querySelector('.ProseMirror');
          if (editor) {
            editor.focus();
            document.execCommand('insertText', false, ${JSON.stringify(args.content)});
            return 'filled: ' + editor.textContent.length + ' chars';
          }
          return 'not found';
        })()`
      });
      console.log('正文:', contentResult.result?.result?.value);
      
      await sleep(1000);
      
      // ========== 步骤7: 点击发布 ==========
      console.log('\n[7] 点击发布...');
      const publishResult = await sendCommand('Runtime.evaluate', {
        expression: `(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === '发布');
          if (btn) { btn.click(); return 'clicked'; }
          return 'not found';
        })()`
      });
      console.log('发布按钮:', publishResult.result?.result?.value);
      
      await sleep(5000);
      
      // ========== 步骤8: 验证发布结果 ==========
      console.log('\n[8] 验证发布结果...');
      const verifyResult = await sendCommand('Runtime.evaluate', {
        expression: `(() => {
          const url = window.location.href;
          const published = url.includes('/publish/success');
          return JSON.stringify({ url: url.substring(0, 50), published });
        })()`
      });
      
      const verify = JSON.parse(verifyResult.result?.result?.value || '{}');
      console.log('发布状态:', verify.published ? '✅ 成功' : '❌ 失败');
      console.log('URL:', verify.url);
      
      // 关闭 WebSocket
      ws.close();
      
      // ========== 步骤9: 用代理关闭页面 ==========
      console.log('\n[9] 关闭页面...');
      const closeResp = await fetch(`${PROXY_BASE}/close?target=${TARGET_ID}&metaAgentScope=${args.scope}`, { method: 'DELETE' });
      const closeResult = await closeResp.json();
      console.log('关闭结果:', closeResult.ok ? '✅ 成功' : '❌ 失败');
      
      console.log('\n=== 发布完成 ===');
      console.log('发布成功:', verify.published);
      
      process.exit(verify.published ? 0 : 1);
      
    } catch (e) {
      console.error('\n❌ 错误:', e.message);
      ws.close();
      
      // 确保任何情况下都关闭页面
      console.log('\n清理页面...');
      await fetch(`${PROXY_BASE}/close?target=${TARGET_ID}&metaAgentScope=${args.scope}`, { method: 'DELETE' });
      
      process.exit(1);
    }
  });
}

main().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});