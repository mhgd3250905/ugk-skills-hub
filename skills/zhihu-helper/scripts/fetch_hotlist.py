#!/usr/bin/env python3
"""快速获取知乎热榜
用法:
  python3 fetch_hotlist.py [条目数]              # 默认 DOM 提取
  python3 fetch_hotlist.py [条目数] --api         # API 方式（更快更稳定）
  python3 fetch_hotlist.py [条目数] --dom         # 显式指定 DOM 提取
"""

import subprocess
import json
import sys
import time
import os
import urllib.parse

# Scope env names matching browser-cleanup.ts and agent-run-scope.ts
_SCOPE_ENV_NAMES = ['CLAUDE_AGENT_ID', 'CLAUDE_HOOK_AGENT_ID', 'agent_id']


def _resolve_agent_scope(default_prefix='zhihu-hotlist'):
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
    """解析 cdp-proxy /eval 返回的 JSON（可能双层编码）"""
    if raw.startswith('{"ok": false'):
        return json.loads(raw)
    if raw.startswith('"'):
        return json.loads(json.loads(raw))
    return json.loads(raw)


def fetch_hotlist_api(limit: int, scope: str) -> dict:
    """通过知乎热榜 JSON API 获取热榜（推荐方式）

    端点: /api/v3/feed/topstory/hot-lists/total?limit=50&desktop=true
    需在浏览器内 fetch，自动携带登录态。
    """
    target_id = ''
    try:
        # 打开知乎首页（比 /hot 更轻量）
        url = urllib.parse.quote('https://www.zhihu.com', safe='')
        resp = curl([f'http://127.0.0.1:3456/new?url={url}&metaAgentScope={scope}'])
        target_id = json.loads(resp).get('targetId', '')
        if not target_id:
            return {"ok": False, "error": "无法创建浏览器页面"}

        time.sleep(2)

        # 浏览器内 fetch 调热榜 API
        # 返回字段说明（实测 2026-05-11）：
        #   target.title / target.excerpt / target.url（api.zhihu.com 格式）
        #   item.detail_text = 热度值（如 "3326 万热度"）
        #   item.card_id = Q_{questionId}
        js = '''(async()=>{
  const r = await fetch('https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50&desktop=true', {credentials:'include'});
  const data = await r.json();
  const items = [];
  for (const item of data.data || []) {
    if (item.type === 'hot_list_feed') {
      const t = item.target || {};
      const qid = (item.card_id || '').replace('Q_', '');
      items.push({
        rank: items.length + 1,
        title: (t.title || '').trim(),
        excerpt: (t.excerpt || '').trim().substring(0, 100),
        metrics: (item.detail_text || '').trim(),
        url: qid ? 'https://www.zhihu.com/question/' + qid : (t.url || ''),
        questionId: qid
      });
    }
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
        return {"ok": True, "count": len(data), "data": data, "method": "api"}

    except Exception as e:
        return {"ok": False, "error": f"API 方式失败: {e}"}
    finally:
        if target_id:
            curl(['-X', 'DELETE',
                  f'http://127.0.0.1:3456/close?target={target_id}&metaAgentScope={scope}'])


def fetch_hotlist_dom(limit: int, scope: str) -> dict:
    """通过 DOM 提取获取热榜（传统方式，兼容保留）"""
    target_id = ''
    try:
        url = urllib.parse.quote('https://www.zhihu.com/hot', safe='')
        resp = curl([f'http://127.0.0.1:3456/new?url={url}&metaAgentScope={scope}'])
        target_id = json.loads(resp).get('targetId', '')
        if not target_id:
            return {"ok": False, "error": "无法创建浏览器页面"}

        # 智能等待 DOM 元素出现（最多 6 秒）
        max_wait = 6.0
        interval = 0.3
        waited = 0.0
        while waited < max_wait:
            raw = curl([f'http://127.0.0.1:3456/eval?target={target_id}&metaAgentScope={scope}',
                        '-d', 'document.querySelectorAll(".HotList-list .HotItem").length'])
            count = int(raw.strip('"')) if raw else 0
            if count >= 5:
                break
            time.sleep(interval)
            waited += interval

        _script_dir = os.path.dirname(os.path.abspath(__file__))
        script_path = os.path.join(_script_dir, 'extract-hotlist-inline.js')
        with open(script_path) as f:
            script = f.read()

        result = curl(['-X', 'POST',
                       f'http://127.0.0.1:3456/eval?target={target_id}&metaAgentScope={scope}',
                       '--data-binary', script])

        data = _parse_eval_result(result)
        if not isinstance(data, list):
            return {"ok": False, "error": f"DOM 提取结果异常: {str(data)[:200]}"}

        data = data[:limit]
        return {"ok": True, "count": len(data), "data": data, "method": "dom"}

    except Exception as e:
        return {"ok": False, "error": f"DOM 方式失败: {e}"}
    finally:
        if target_id:
            curl(['-X', 'DELETE',
                  f'http://127.0.0.1:3456/close?target={target_id}&metaAgentScope={scope}'])


def main():
    # 解析参数：fetch_hotlist.py [条数] [--api|--dom]
    args = sys.argv[1:]
    limit = 10
    use_api = False      # 默认 DOM
    use_dom_explicit = False

    for a in args:
        if a == '--api':
            use_api = True
        elif a == '--dom':
            use_dom_explicit = True
        else:
            try:
                limit = int(a)
            except ValueError:
                pass

    method = 'api' if use_api else 'dom'

    if not ensure_proxy():
        print(json.dumps({"ok": False, "error": "cdp-proxy 无法启动"}))
        return

    scope = _resolve_agent_scope(f'zhihu-hotlist-{method}')
    start_time = time.time()

    if use_api:
        result = fetch_hotlist_api(limit, scope)
    else:
        result = fetch_hotlist_dom(limit, scope)

    elapsed = time.time() - start_time
    result["elapsed"] = f"{elapsed:.2f}s"
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()