#!/usr/bin/env python3
"""获取知乎用户收藏夹列表

用法:
  python3 fetch_collections.py [条数]

参数:
  条数: 可选，默认 10，最大 20

输出:
  用户所有收藏夹列表，包含 id、title、item_count、is_public

示例:
  python3 fetch_collections.py
  python3 fetch_collections.py 20
"""

import subprocess
import json
import sys
import time
import os

import subprocess

# Scope env names matching browser-cleanup.ts and agent-run-scope.ts
_SCOPE_ENV_NAMES = ['CLAUDE_AGENT_ID', 'CLAUDE_HOOK_AGENT_ID', 'agent_id']

def _resolve_agent_scope(default_prefix='zhihu-collections'):
    """Read env scope first so conn cleanup can close pages."""
    for name in _SCOPE_ENV_NAMES:
        val = os.environ.get(name, '').strip()
        if val:
            return val
    return f"{default_prefix}-{int(time.time())}"

def ensure_proxy():
    """确保 cdp-proxy 正在运行"""
    result = subprocess.run(['curl', '-s', 'http://127.0.0.1:3456/health'], 
                           capture_output=True, text=True, timeout=2)
    if result.returncode != 0 or '"status": "ok"' not in result.stdout:
        # 启动 proxy
        subprocess.Popen(['node', '/app/runtime/skills-user/web-access/scripts/cdp-proxy.mjs'],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        import time
        for _ in range(10):
            time.sleep(0.5)
            result = subprocess.run(['curl', '-s', 'http://127.0.0.1:3456/health'],
                                   capture_output=True, text=True, timeout=2)
            if '"status": "ok"' in result.stdout:
                return True
        return False
    return True


LIMIT = min(int(sys.argv[1]) if len(sys.argv) > 1 else 10, 20)
SCOPE = _resolve_agent_scope()

def curl(args: list) -> str:
    result = subprocess.run(['curl', '-s'] + args, capture_output=True, text=True)
    return result.stdout.strip()

def main():
    if not ensure_proxy():
        print(json.dumps({"ok": False, "error": "cdp-proxy 无法启动"}))
        return
    start_time = time.time()
    target_id = ''
    
    try:
        # 创建新页面（知乎首页，获取登录态）
        resp = curl([f'http://127.0.0.1:3456/new?url=https://www.zhihu.com&metaAgentScope={SCOPE}'])
        target_id = json.loads(resp).get('targetId', '')
        
        if not target_id:
            print(json.dumps({"ok": False, "error": "无法创建浏览器页面"}))
            return
        
        # 等待页面加载
        time.sleep(2)
        
        # 获取用户信息
        user_script = "(async()=>{const resp=await fetch('https://www.zhihu.com/api/v4/me',{credentials:'include'});return JSON.stringify(await resp.json());})()"
        user_result = curl(['-X', 'POST', 
                           f'http://127.0.0.1:3456/eval?target={target_id}&metaAgentScope={SCOPE}',
                           '--data-binary', user_script])
        
        if user_result.startswith('"'):
            user_data = json.loads(json.loads(user_result))
        else:
            user_data = json.loads(user_result)
        
        url_token = user_data.get('url_token', '')
        
        if not url_token:
            print(json.dumps({"ok": False, "error": "未获取到用户 url_token，可能未登录"}))
            return
        
        # 获取收藏夹列表
        coll_script = f"(async()=>{{const resp=await fetch('https://www.zhihu.com/api/v4/people/{url_token}/collections?limit={LIMIT}',{{credentials:'include'}});return JSON.stringify(await resp.json());}})()"
        coll_result = curl(['-X', 'POST', 
                           f'http://127.0.0.1:3456/eval?target={target_id}&metaAgentScope={SCOPE}',
                           '--data-binary', coll_script])
        
        # 解析结果
        try:
            if coll_result.startswith('"'):
                data = json.loads(json.loads(coll_result))
            else:
                data = json.loads(coll_result)
            
            if isinstance(data, dict) and 'data' in data:
                collections = data['data']
                
                elapsed = time.time() - start_time
                output = {
                    "ok": True,
                    "urlToken": url_token,
                    "count": len(collections),
                    "elapsed": f"{elapsed:.2f}s",
                    "data": [{
                        "id": c.get("id"),
                        "title": c.get("title"),
                        "itemCount": c.get("item_count", 0),
                        "isPublic": c.get("is_public", True),
                        "url": c.get("url")
                    } for c in collections]
                }
                print(json.dumps(output, ensure_ascii=False, indent=2))
            else:
                print(json.dumps({"ok": False, "error": "API 返回格式异常"}))
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"解析失败: {e}"}))
    finally:
        # 关闭页面
        if target_id:
            curl(['-X', 'DELETE', f'http://127.0.0.1:3456/close?target={target_id}&metaAgentScope={SCOPE}'])

if __name__ == '__main__':
    main()