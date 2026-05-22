#!/usr/bin/env python3
"""获取知乎问题回答列表

用法:
  python3 fetch_answers.py <问题ID> [条数] [排序方式]

参数:
  问题ID: 必填，知乎问题 ID
  条数: 可选，默认 5，最大 20
  排序方式: 可选，votes(按赞)/created(按时间)/default，默认 votes

示例:
  python3 fetch_answers.py 2031783702569726072
  python3 fetch_answers.py 2031783702569726072 10 votes
"""

import subprocess
import json
import sys
import time
import os

import subprocess

# Scope env names matching browser-cleanup.ts and agent-run-scope.ts
_SCOPE_ENV_NAMES = ['CLAUDE_AGENT_ID', 'CLAUDE_HOOK_AGENT_ID', 'agent_id']

def _resolve_agent_scope(default_prefix='zhihu-answers'):
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

import urllib.parse

QUESTION_ID = sys.argv[1] if len(sys.argv) > 1 else None
LIMIT = min(int(sys.argv[2]) if len(sys.argv) > 2 else 5, 20)
SORT_BY = sys.argv[3] if len(sys.argv) > 3 else 'votes'

if not QUESTION_ID:
    print(json.dumps({"ok": False, "error": "缺少问题ID参数"}))
    sys.exit(1)

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
        # 创建新页面
        url = urllib.parse.quote(f'https://www.zhihu.com/question/{QUESTION_ID}', safe='')
        resp = curl([f'http://127.0.0.1:3456/new?url={url}&metaAgentScope={SCOPE}'])
        target_id = json.loads(resp).get('targetId', '')
        
        if not target_id:
            print(json.dumps({"ok": False, "error": "无法创建浏览器页面"}))
            return
        
        # 等待页面加载
        time.sleep(2)
        
        # 使用浏览器内 API 获取回答
        include = 'data[*].author.name,voteup_count,comment_count,created_time,excerpt'
        script = f"(async()=>{{const resp=await fetch('https://www.zhihu.com/api/v4/questions/{QUESTION_ID}/answers?limit={LIMIT}&sort_by={SORT_BY}&include={include}',{{credentials:'include'}});return JSON.stringify(await resp.json());}})()"
        
        result = curl(['-X', 'POST', 
                       f'http://127.0.0.1:3456/eval?target={target_id}&metaAgentScope={SCOPE}',
                       '--data-binary', script])
        
        # 解析结果
        try:
            if result.startswith('"'):
                data = json.loads(json.loads(result))
            else:
                data = json.loads(result)
            
            if isinstance(data, dict) and 'data' in data:
                answers = data['data']
                total = data.get('paging', {}).get('total', len(answers))
                
                elapsed = time.time() - start_time
                output = {
                    "ok": True,
                    "questionId": QUESTION_ID,
                    "count": len(answers),
                    "total": total,
                    "sortBy": SORT_BY,
                    "elapsed": f"{elapsed:.2f}s",
                    "data": answers
                }
                print(json.dumps(output, ensure_ascii=False, indent=2))
            else:
                print(json.dumps({"ok": False, "error": "API 返回格式异常", "raw": result[:200]}))
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"解析失败: {e}"}))
    finally:
        # 关闭页面
        if target_id:
            curl(['-X', 'DELETE', f'http://127.0.0.1:3456/close?target={target_id}&metaAgentScope={SCOPE}'])

if __name__ == '__main__':
    main()