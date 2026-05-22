#!/usr/bin/env python3
"""Reddit 数据接口命令行工具

通过 Reddit 公开 JSON API 提供结构化数据。仅限读取，不涉及登录或发帖。

用法:
  python3 reddit.py search <query> [--sort relevance|hot|new|top|comments] [--time hour|day|week|month|year|all] [--limit N] [--subreddit SUB]
  python3 reddit.py subreddit <name> [--sort hot|new|rising|top|controversial] [--time hour|day|week|month|year|all] [--limit N] [--after ID] [--before ID]
  python3 reddit.py post <url_or_permalink> [--comments-limit N] [--comments-sort best|top|new|controversial|old|qa]
  python3 reddit.py find-subreddit <query> [--limit N]
  python3 reddit.py trending

输出: JSON
"""

import sys
import os
import json
import argparse
import subprocess
import urllib.request
import urllib.parse
from datetime import datetime, timezone

BASE = "https://www.reddit.com"
HEADERS = {
    "User-Agent": "pi-search-agent/1.0 (search skill)",
}
TIMEOUT = 15


def fetch(url):
    """请求 JSON API"""
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8", errors="replace"))


def format_timestamp(ts):
    """将 Unix 时间戳转为 ISO 格式"""
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def extract_post(d):
    """从 t3 数据中提取精简字段"""
    return {
        "id": d.get("id"),
        "name": d.get("name"),
        "title": d.get("title"),
        "author": d.get("author"),
        "subreddit": d.get("subreddit"),
        "subreddit_name_prefixed": d.get("subreddit_name_prefixed"),
        "score": d.get("score"),
        "upvote_ratio": d.get("upvote_ratio"),
        "num_comments": d.get("num_comments"),
        "created_utc": format_timestamp(d.get("created_utc")),
        "selftext": d.get("selftext", ""),
        "url": d.get("url", ""),
        "permalink": d.get("permalink", ""),
        "is_self": d.get("is_self", False),
        "link_flair_text": d.get("link_flair_text"),
        "over_18": d.get("over_18", False),
        "spoiler": d.get("spoiler", False),
        "thumbnail": d.get("thumbnail", ""),
        "domain": d.get("domain", ""),
    }


def extract_comment(d, depth=0):
    """从 t1 数据中提取精简评论（含嵌套回复）"""
    result = {
        "id": d.get("id"),
        "author": d.get("author"),
        "body": d.get("body", ""),
        "score": d.get("score"),
        "created_utc": format_timestamp(d.get("created_utc")),
        "is_submitter": d.get("is_submitter", False),
        "depth": depth,
    }
    replies = d.get("replies")
    if isinstance(replies, dict) and replies.get("data", {}).get("children"):
        result["replies"] = []
        for child in replies["data"]["children"]:
            if child["kind"] == "t1":
                result["replies"].append(extract_comment(child["data"], depth + 1))
    return result


# ---- 命令实现 ----

def cmd_search(args):
    """全站搜索或子版块内搜索"""
    q = urllib.parse.quote(args.query, safe="")
    params = [f"q={q}", "raw_json=1"]
    if args.sort:
        params.append(f"sort={args.sort}")
    if args.time:
        params.append(f"t={args.time}")
    if args.limit:
        params.append(f"limit={args.limit}")
    else:
        params.append("limit=10")

    if args.subreddit:
        url = f"{BASE}/r/{args.subreddit}/search.json?restrict_sr=on&{'&'.join(params)}"
    else:
        url = f"{BASE}/search.json?{'&'.join(params)}"

    data = fetch(url)
    posts = []
    for child in data["data"]["children"]:
        if child["kind"] == "t3":
            posts.append(extract_post(child["data"]))

    return {
        "query": args.query,
        "subreddit": args.subreddit,
        "sort": args.sort,
        "time": args.time,
        "count": len(posts),
        "after": data["data"].get("after"),
        "before": data["data"].get("before"),
        "posts": posts,
    }


def cmd_subreddit(args):
    """获取子版块帖子列表"""
    sort = args.sort or "hot"
    params = ["raw_json=1"]
    if sort in ("top", "controversial") and args.time:
        params.append(f"t={args.time}")
    if args.limit:
        params.append(f"limit={args.limit}")
    else:
        params.append("limit=25")
    if args.after:
        params.append(f"after={args.after}")
    if args.before:
        params.append(f"before={args.before}")

    url = f"{BASE}/r/{args.subreddit}/{sort}.json?{'&'.join(params)}"
    data = fetch(url)
    posts = []
    for child in data["data"]["children"]:
        if child["kind"] == "t3":
            posts.append(extract_post(child["data"]))

    return {
        "subreddit": args.subreddit,
        "sort": sort,
        "time": args.time,
        "count": len(posts),
        "after": data["data"].get("after"),
        "before": data["data"].get("before"),
        "posts": posts,
    }


def cmd_post(args):
    """获取帖子详情和评论"""
    target = args.target.rstrip("/")

    # 构造 URL
    if target.startswith("http"):
        permalink = target
    elif target.startswith("/r/"):
        permalink = BASE + target
    else:
        return {"error": f"无效的帖子标识: {target}"}

    # 确保以 .json 结尾
    if permalink.endswith("/"):
        permalink = permalink[:-1]
    if not permalink.endswith(".json"):
        permalink += ".json"

    params = ["raw_json=1"]
    if args.comments_limit:
        params.append(f"limit={args.comments_limit}")
    if args.comments_sort:
        params.append(f"sort={args.comments_sort}")

    url = f"{permalink}?{'&'.join(params)}"
    data = fetch(url)

    # data 是长度为 2 的数组：[帖子, 评论]
    result = {}

    if len(data) >= 1 and data[0]["data"]["children"]:
        post_data = data[0]["data"]["children"][0]["data"]
        result["post"] = extract_post(post_data)
        # 附加额外详情
        result["post"]["selftext_html"] = post_data.get("selftext_html")

    if len(data) >= 2:
        comments = []
        for child in data[1]["data"]["children"]:
            if child["kind"] == "t1":
                comments.append(extract_comment(child["data"]))
        result["comments"] = comments
        result["comments_count_returned"] = len(comments)

    return result


def cmd_find_subreddit(args):
    """搜索子版块"""
    q = urllib.parse.quote(args.query, safe="")
    limit = args.limit or 10
    url = f"{BASE}/subreddits/search.json?q={q}&limit={limit}&raw_json=1"
    data = fetch(url)

    subreddits = []
    for child in data["data"]["children"]:
        if child["kind"] == "t5":
            d = child["data"]
            subreddits.append({
                "name": d.get("display_name"),
                "title": d.get("title"),
                "subscribers": d.get("subscribers"),
                "public_description": d.get("public_description", ""),
                "over18": d.get("over18", False),
                "url": f"{BASE}/r/{d.get('display_name')}",
                "description": d.get("description_html", ""),
            })

    return {
        "query": args.query,
        "count": len(subreddits),
        "after": data["data"].get("after"),
        "subreddits": subreddits,
    }


def cmd_trending(args):
    """获取 Reddit 默认推荐/热门子版块"""
    url = f"{BASE}/subreddits/default.json?limit=25&raw_json=1"
    data = fetch(url)
    subreddits = []
    for child in data["data"].get("children", []):
        if child["kind"] == "t5":
            d = child["data"]
            subreddits.append({
                "name": d.get("display_name"),
                "title": d.get("title"),
                "subscribers": d.get("subscribers"),
                "public_description": d.get("public_description", ""),
                "url": f"{BASE}/r/{d.get('display_name')}",
            })
    return {
        "count": len(subreddits),
        "default_subreddits": subreddits,
    }


# ---- CLI ----

def main():
    parser = argparse.ArgumentParser(description="Reddit 数据接口")
    sub = parser.add_subparsers(dest="command", required=True)

    # search
    p = sub.add_parser("search", help="搜索帖子（全站或子版块内）")
    p.add_argument("query", help="搜索关键词")
    p.add_argument("--sort", default="relevance", choices=["relevance", "hot", "new", "top", "comments"], help="排序方式")
    p.add_argument("--time", default="all", choices=["hour", "day", "week", "month", "year", "all"], help="时间范围")
    p.add_argument("--limit", type=int, default=None, help="限制返回数量（默认 10，最大 100）")
    p.add_argument("--subreddit", default=None, help="限定在某个子版块内搜索")

    # subreddit
    p = sub.add_parser("subreddit", help="获取子版块帖子列表")
    p.add_argument("subreddit", help="子版块名称（不含 r/）")
    p.add_argument("--sort", default="hot", choices=["hot", "new", "rising", "top", "controversial"], help="排序方式")
    p.add_argument("--time", default="week", choices=["hour", "day", "week", "month", "year", "all"], help="时间范围（仅 top/controversial 有效）")
    p.add_argument("--limit", type=int, default=None, help="限制返回数量（默认 25，最大 100）")
    p.add_argument("--after", default=None, help="翻页：上一页返回的 after 游标")
    p.add_argument("--before", default=None, help="翻页：上一页返回的 before 游标")

    # post
    p = sub.add_parser("post", help="获取帖子详情和评论")
    p.add_argument("target", help="帖子 URL 或 permalink（如 /r/xxx/comments/abc/...）")
    p.add_argument("--comments-limit", type=int, default=20, help="评论数量限制（默认 20）")
    p.add_argument("--comments-sort", default="best", choices=["best", "top", "new", "controversial", "old", "qa"], help="评论排序方式")

    # find-subreddit
    p = sub.add_parser("find-subreddit", help="搜索子版块")
    p.add_argument("query", help="搜索关键词")
    p.add_argument("--limit", type=int, default=None, help="限制返回数量（默认 10）")

    # trending
    p = sub.add_parser("trending", help="当前趋势子版块")

    args = parser.parse_args()

    try:
        if args.command == "search":
            data = cmd_search(args)
        elif args.command == "subreddit":
            data = cmd_subreddit(args)
        elif args.command == "post":
            data = cmd_post(args)
        elif args.command == "find-subreddit":
            data = cmd_find_subreddit(args)
        elif args.command == "trending":
            data = cmd_trending(args)
        else:
            data = {"error": f"未知命令: {args.command}"}

        print(json.dumps(data, ensure_ascii=False, indent=2))
    except urllib.error.HTTPError as e:
        if e.code == 403:
            # 浏览器通道降级（绕过 IP 封禁）
            script_dir = os.path.dirname(os.path.abspath(__file__))
            browser_script = os.path.join(script_dir, "reddit-browser.mjs")
            cmd = ["node", browser_script] + sys.argv[1:]
            print(f"[reddit] HTTP 403, falling back to browser channel...", file=sys.stderr)
            try:
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
                if result.returncode == 0:
                    print(result.stdout)
                    return 0
                else:
                    if result.stderr:
                        print(result.stderr, file=sys.stderr)
                    else:
                        print("Error: browser channel failed (Chrome sidecar not connected? Try the web-access skill first.)", file=sys.stderr)
                    return 1
            except FileNotFoundError:
                print("Error: node not found, browser fallback unavailable", file=sys.stderr)
                return 1
            except subprocess.TimeoutExpired:
                print("Error: browser channel timed out", file=sys.stderr)
                return 1

        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            pass
        print(json.dumps({"error": f"HTTP {e.code}: {e.reason}", "body": body}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    raise SystemExit(main())
