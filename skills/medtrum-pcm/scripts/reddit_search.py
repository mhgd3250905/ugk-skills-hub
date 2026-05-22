#!/usr/bin/env python3
"""
Reddit search wrapper — 双通道降级策略。

通道 1（优先）：调用 reddit-data skill 的 reddit.py search（HTTP JSON API）
通道 2（降级）：HTTP API 被反爬封禁时，切回原浏览器方案 reddit_search.mjs

用法: python3 reddit_search.py <keyword> [days]
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone, timedelta

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REDDIT_PY = "/app/runtime/skills-user/reddit-data/scripts/reddit.py"
REDDIT_MJS = os.path.join(SCRIPT_DIR, "reddit_search.mjs")


def run_api(keyword, days):
    """通道 1：HTTP JSON API"""
    cmd = [
        sys.executable, REDDIT_PY,
        "search", keyword,
        "--sort", "new",
        "--time", "month",
        "--limit", "100",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)

    if proc.returncode != 0:
        return None, proc.stderr

    try:
        raw = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None, proc.stdout

    # API 返回了 error 字段
    if "error" in raw:
        return None, json.dumps(raw)

    posts = raw.get("posts", [])
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    valid_items = []
    dropped = 0

    for post in posts:
        created_str = post.get("created_utc", "")
        if not created_str:
            dropped += 1
            continue
        try:
            if " UTC" in created_str:
                created_dt = datetime.strptime(created_str, "%Y-%m-%d %H:%M:%S UTC").replace(tzinfo=timezone.utc)
            else:
                created_dt = datetime.fromisoformat(created_str)
        except (ValueError, TypeError):
            dropped += 1
            continue
        if created_dt < cutoff:
            dropped += 1
            continue

        date_str = created_dt.strftime("%Y-%m-%d")
        author = post.get("author", "unknown").strip() or "unknown"
        title = post.get("title", "") or ""
        selftext = post.get("selftext", "") or ""
        content = (title + " - " + selftext if selftext else title)[:300].strip()
        permalink = post.get("permalink", "") or ""
        url = f"https://www.reddit.com{permalink}" if permalink.startswith("/") else permalink

        if not content or len(content) < 10:
            dropped += 1
            continue

        valid_items.append({
            "date": date_str,
            "author": author,
            "content": content,
            "url": url,
        })

    result = {
        "platform": "Reddit",
        "keyword": keyword,
        "retrievedAt": datetime.now(timezone.utc).isoformat(),
        "queryUrl": f"https://www.reddit.com/search/?q={keyword}&sort=new",
        "total": len(valid_items),
        "dropped": dropped,
        "items": valid_items,
    }
    return result, None


def run_browser(keyword, days):
    """通道 2：浏览器降级（原 reddit_search.mjs）"""
    cmd = [
        "node", REDDIT_MJS,
        keyword, str(days),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)

    if proc.stderr:
        print(proc.stderr, file=sys.stderr)

    if proc.returncode != 0:
        if "REDDIT_PREFLIGHT_FAILED" in (proc.stderr or ""):
            print("PREFLIGHT_FAILED: browser channel preflight failed", file=sys.stderr)
            sys.exit(2)
        sys.exit(proc.returncode)

    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        print("Error: browser channel returned invalid JSON", file=sys.stderr)
        sys.exit(1)


def main():
    keyword = sys.argv[1] if len(sys.argv) > 1 else ""
    days = int(sys.argv[2]) if len(sys.argv) > 2 else 30

    if not keyword:
        print("Error: keyword required", file=sys.stderr)
        sys.exit(1)

    # ---- 通道 1：优先尝试 HTTP API ----
    print(f"[reddit] 通道1: HTTP API 搜索 '{keyword}'...", file=sys.stderr)
    result, err = run_api(keyword, days)

    if result is not None:
        print(f"[reddit] 通道1 成功: {result['total']} 条", file=sys.stderr)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    else:
        print(f"[reddit] 通道1 失败，尝试降级...", file=sys.stderr)
        if err:
            # 只打印前 300 字符避免刷屏
            print(err[:300], file=sys.stderr)

    # ---- 通道 2：降级到浏览器方案 ----
    print(f"[reddit] 通道2: 浏览器搜索 '{keyword}'...", file=sys.stderr)
    result = run_browser(keyword, days)
    print(f"[reddit] 通道2 完成: {result.get('total', 0)} 条", file=sys.stderr)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
