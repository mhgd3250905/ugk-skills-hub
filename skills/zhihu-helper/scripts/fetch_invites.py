#!/usr/bin/env python3
"""获取知乎邀请回答列表

从创作者中心的「邀请回答」页面提取别人邀请你回答的问题列表。
包含两类：
  - invited_me: 别人主动邀请你回答的
  - question_expects: 提问期待你解答的（推荐）

用法:
  python3 fetch_invites.py [条数]

参数:
  条数: 可选，默认返回全部

示例:
  python3 fetch_invites.py
  python3 fetch_invites.py 5

重试机制: 如果页面返回 0 条邀请，会自动重试一次（避免 SSR 临时性加载失败）。
"""

import subprocess
import json
import sys
import time
import os
import urllib.parse

# Scope env names matching browser-cleanup.ts and agent-run-scope.ts
_SCOPE_ENV_NAMES = ['CLAUDE_AGENT_ID', 'CLAUDE_HOOK_AGENT_ID', 'agent_id']


def _resolve_agent_scope(default_prefix='zhihu-invites'):
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


LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 0
SCOPE = _resolve_agent_scope(default_prefix='zhihu-invites')
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def curl(args: list) -> str:
    result = subprocess.run(['curl', '-s'] + args, capture_output=True, text=True)
    return result.stdout.strip()


def _do_fetch(scope: str, limit: int):
    """执行一次实际的抓取，返回 (output_dict, target_id) 或 (None, error_info)"""
    target_id = ''
    try:
        url = urllib.parse.quote(
            'https://www.zhihu.com/creator/featured-question/invited',
            safe=''
        )
        resp = curl([f'http://127.0.0.1:3456/new?url={url}&metaAgentScope={scope}'])
        target_id = json.loads(resp).get('targetId', '')

        if not target_id:
            return None, '无法创建浏览器页面'

        # 等待页面渲染（SSR 页面，3 秒足够）
        time.sleep(3)

        # 读取提取脚本并执行
        script_path = os.path.join(SCRIPT_DIR, 'extract-invites.js')
        result = curl([
            '-X', 'POST',
            f'http://127.0.0.1:3456/eval?target={target_id}&metaAgentScope={scope}',
            '--data-binary', f'@{script_path}'
        ])

        if result.startswith('{"ok": false'):
            return None, result

        # CDP eval 返回的是 JSON 字符串，需要双重解析
        if result.startswith('"'):
            invites = json.loads(json.loads(result))
        else:
            invites = json.loads(result)

        if not isinstance(invites, list):
            return None, f'返回格式异常: {result[:200]}'

        invited_count = sum(1 for i in invites if i['type'] == 'invited_me')
        expect_count = sum(1 for i in invites if i['type'] == 'question_expects')

        if limit > 0:
            invites = invites[:limit]

        output = {
            "ok": True,
            "count": len(invites),
            "total": {
                "invited_me": invited_count,
                "question_expects": expect_count
            },
            "data": invites
        }
        return output, target_id

    except Exception as e:
        return None, f'抓取异常: {e}'
    finally:
        if target_id:
            curl(['-X', 'DELETE',
                  f'http://127.0.0.1:3456/close?target={target_id}&metaAgentScope={scope}'])


def main():
    if not ensure_proxy():
        print(json.dumps({"ok": False, "error": "cdp-proxy 无法启动"}))
        return

    # 第一次抓取
    output, _ = _do_fetch(SCOPE, LIMIT)

    if output is None:
        print(json.dumps({"ok": False, "error": "首次抓取失败"}))
        return

    # 如果返回 0 条，重试一次（避免 SSR 临时性加载失败）
    if output['count'] == 0:
        time.sleep(3)
        retry_output, _ = _do_fetch(SCOPE, LIMIT)
        if retry_output is not None and retry_output['count'] > 0:
            output = retry_output

    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
