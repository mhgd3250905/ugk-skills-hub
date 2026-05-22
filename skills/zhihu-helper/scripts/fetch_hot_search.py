#!/usr/bin/env python3
"""获取知乎热搜（搜索热词）

用法:
  python3 fetch_hot_search.py [条数，默认30，API 固定返回30条]

与热榜的区别:
  - 热榜 (fetch_hotlist.py) = 热门问题，有 questionId，可直接获取回答
  - 热搜 (fetch_hot_search.py) = 搜索热词，无直接链接，需搜索后找相关内容

API: /api/v4/search/hot_search（浏览器内 fetch，自动携带登录态）
"""

import subprocess
import json
import sys
import time
import os
import urllib.parse

_SCOPE_ENV_NAMES = ['CLAUDE_AGENT_ID', 'CLAUDE_HOOK_AGENT_ID', 'agent_id']


def _resolve_agent_scope(default_prefix='zhihu-hot-search'):
    for name in _SCOPE_ENV_NAMES:
        val = os.environ.get(name, '').strip()
        if val:
            return val
    return f"{default_prefix}-{int(time.time())}"


def ensure_proxy():
    result = subprocess.run(['curl', '-s', 'http://127.0.0.1:3456/health'],
                           capture_output=True, text=True, timeout=2)
    if result.returncode != 0 or '"status": "ok"' not in result.stdout:
        subprocess.Popen(['node', '/app/runtime/skills-user/web-access/scripts/cdp-proxy.mjs'],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(10):
            time.sleep(0.5)
            result = subprocess.run(['curl', '-s', 'http://127.0.0.1:3456/health'],
                                   capture_output=True, text=True, timeout=2)
            if '"status": "ok"' in result.stdout:
                return True
        return False
    return True


def curl(args: list) -> str:
    result = subprocess.run(['curl', '-s'] + args, capture_output=True, text=True)
    return result.stdout.strip()


def _parse_eval_result(raw: str):
    if raw.startswith('{"ok": false'):
        return json.loads(raw)
    if raw.startswith('"'):
        return json.loads(json.loads(raw))
    return json.loads(raw)


def fetch_hot_search(limit: int, scope: str) -> dict:
    """通过知乎热搜 JSON API 获取搜索热词"""
    target_id = ''
    try:
        url = urllib.parse.quote('https://www.zhihu.com', safe='')
        resp = curl([f'http://127.0.0.1:3456/new?url={url}&metaAgentScope={scope}'])
        target_id = json.loads(resp).get('targetId', '')
        if not target_id:
            return {"ok": False, "error": "无法创建浏览器页面"}

        time.sleep(2)

        js = '''(async()=>{
  const r = await fetch('https://www.zhihu.com/api/v4/search/hot_search', {credentials:'include'});
  const data = await r.json();
  const items = [];
  let rank = 0;
  for (const q of data.hot_search_queries || []) {
    rank++;
    items.push({
      rank: rank,
      query: q.query || '',
      realQuery: q.real_query || '',
      hotShow: q.hot_show || '',
      hot: q.hot || 0,
      label: q.label || ''
    });
  }
  return JSON.stringify(items);
})()'''

        result = curl(['-X', 'POST',
                       f'http://127.0.0.1:3456/eval?target={target_id}&metaAgentScope={scope}',
                       '--data-binary', js])

        data = _parse_eval_result(result)
        if not isinstance(data, list):
            return {"ok": False, "error": f"API 返回格式异常: {str(data)[:200]}"}

        data = data[:limit]
        return {"ok": True, "count": len(data), "data": data}

    except Exception as e:
        return {"ok": False, "error": f"获取热搜失败: {e}"}
    finally:
        if target_id:
            curl(['-X', 'DELETE',
                  f'http://127.0.0.1:3456/close?target={target_id}&metaAgentScope={scope}'])


def main():
    limit = 30
    for a in sys.argv[1:]:
        try:
            limit = int(a)
        except ValueError:
            pass

    if not ensure_proxy():
        print(json.dumps({"ok": False, "error": "cdp-proxy 无法启动"}))
        return

    scope = _resolve_agent_scope()
    start_time = time.time()

    result = fetch_hot_search(limit, scope)

    elapsed = time.time() - start_time
    result["elapsed"] = f"{elapsed:.2f}s"
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
