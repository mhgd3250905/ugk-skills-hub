#!/usr/bin/env python3
"""PTT 数据接口命令行工具

用法:
  python3 ptt.py hotboards [--limit N]
  python3 ptt.py board-list <board> [--page N]
  python3 ptt.py search <board> <query> [--limit N]
  python3 ptt.py article <url_or_path>
  python3 ptt.py allposts [--page N]
  python3 ptt.py categories

输出: JSON
"""

import re
import sys
import json
import urllib.request
import urllib.parse
import argparse

BASE = "https://www.ptt.cc"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Cookie": "over18=1",
}
TIMEOUT = 15


def fetch(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read().decode("utf-8", errors="replace")


def parse_hotboards(html):
    """解析热门看板列表"""
    boards = re.findall(
        r'class="board-name">([^<]+)</div>\s*'
        r'<div class="board-nuser">[^>]*>([^<]*)</span></div>\s*'
        r'<div class="board-class">([^<]*)</div>\s*'
        r'<div class="board-title">([^<]*)</div>',
        html, re.DOTALL
    )
    result = []
    for name, users, cls, title in boards:
        result.append({
            "name": name.strip(),
            "online": int(users.strip()) if users.strip().isdigit() else 0,
            "category": cls.strip(),
            "title": re.sub(r'&#\d+;', '', title.strip()),
            "url": f"{BASE}/bbs/{name.strip()}/index.html",
        })
    return result


def parse_board_list(html, board):
    """解析看板文章列表"""
    # 提取分页信息
    pages = re.findall(rf'href="(/bbs/{board}/index(\d+)\.html)"', html)
    page_nums = [int(n) for _, n in pages]

    entries = re.findall(r'<div class="r-ent">(.*?)(?=<div class="r-ent|<div class="r-list-sep|$)', html, re.DOTALL)

    articles = []
    for b in entries:
        title_m = re.findall(r'<a[^>]*>([^<]+)</a>', b)
        href_m = re.findall(r'href="(/bbs/[^"]+)"', b)
        date_m = re.findall(r'<div class="date">([^<]+)</div>', b)
        author_m = re.findall(r'<div class="author">([^<]+)</div>', b)
        nrec_m = re.findall(r'<div class="nrec">([^<]*)</div>', b)
        mark_m = re.findall(r'<div class="mark">([^<]*)</div>', b)

        if title_m and href_m:
            nrec = nrec_m[0].strip() if nrec_m else ""
            articles.append({
                "title": title_m[0].strip(),
                "href": href_m[0],
                "url": BASE + href_m[0],
                "date": date_m[0].strip() if date_m else "",
                "author": author_m[0].strip() if author_m else "",
                "nrec": nrec if nrec else None,
                "mark": mark_m[0].strip() if mark_m else "",
            })

    return {
        "board": board,
        "articles": articles,
        "pages": {
            "oldest": min(page_nums) if page_nums else None,
            "newest": max(page_nums) if page_nums else None,
        },
    }


def parse_article(html):
    """解析文章详情"""
    result = {"meta": {}, "pushes": [], "content": ""}

    # 元信息
    for field, tag in [("author", "作者"), ("board", "看板"), ("title", "標題"), ("time", "時間")]:
        m = re.search(
            rf'<span class="article-meta-tag">{tag}</span><span class="article-meta-value">([^<]*)</span>',
            html,
        )
        if m:
            result["meta"][field] = m.group(1).strip()

    # 正文 (main-content 中的文本，去掉 meta 行)
    m = re.search(r'<div id="main-content"[^>]*>(.+?)<span class="f2">', html, re.DOTALL)
    if m:
        raw = m.group(1)
        # 去掉 meta 行
        raw = re.sub(
            r'<div class="article-metaline[^"]*">.*?</div>',
            "", raw, flags=re.DOTALL,
        )
        # 去掉推文
        raw = re.sub(r'<div class="push">.*?</div>', "", raw, flags=re.DOTALL)
        # 去掉 HTML 标签
        text = re.sub(r'<[^>]+>', '', raw).strip()
        # 清理多余空白
        text = re.sub(r'\n{3,}', '\n\n', text)
        result["content"] = text

    # 推文
    pushes = re.findall(
        r'class="[^"]*push-tag">([^<]*)</span>\s*'
        r'<span class="[^"]*push-userid">([^<]*)</span>\s*'
        r'<span class="[^"]*push-content">:([^<]*)</span>\s*'
        r'<span class="push-ipdatetime">([^<]*)</span>',
        html,
    )
    push_count = sum(1 for t, _, _, _ in pushes if '推' in t)
    hiss_count = sum(1 for t, _, _, _ in pushes if '噓' in t)
    arrow_count = sum(1 for t, _, _, _ in pushes if '→' in t)

    for tag, uid, content, ipdt in pushes:
        tag_s = tag.strip()
        result["pushes"].append({
            "tag": "push" if '推' in tag_s else ("hiss" if '噓' in tag_s else "arrow"),
            "tag_raw": tag_s,
            "user": uid.strip(),
            "content": content.strip(),
            "ip_datetime": ipdt.strip(),
        })

    result["stats"] = {
        "push": push_count,
        "hiss": hiss_count,
        "arrow": arrow_count,
        "total": len(pushes),
    }

    # OG meta
    og_title = re.findall(r'property="og:title" content="([^"]*)"', html)
    og_desc = re.findall(r'property="og:description" content="([^"]*)"', html)
    if og_title:
        result["og_title"] = og_title[0]
    if og_desc:
        result["og_description"] = og_desc[0]

    return result


def parse_search(html, board):
    """解析搜索结果（与 board_list 共享结构）"""
    return parse_board_list(html, board)


def parse_categories(html):
    """解析分类看板"""
    cats = re.findall(
        r'<a class="board" href="([^"]+)">.*?'
        r'<div class="board-name">([^<]+)</div>.*?'
        r'<div class="board-class">([^<]*)</div>.*?'
        r'<div class="board-title">([^<]*)</div>',
        html, re.DOTALL,
    )
    result = []
    for href, name, cls, title in cats:
        result.append({
            "name": name.strip(),
            "category": cls.strip(),
            "title": re.sub(r'&#\d+;', '', title.strip()),
            "url": BASE + href,
            "path": href,
        })
    return result


# ---- CLI ----

def cmd_hotboards(args):
    html = fetch(f"{BASE}/bbs/hotboards.html")
    data = parse_hotboards(html)
    if args.limit:
        data = data[: args.limit]
    return data


def cmd_board_list(args):
    if args.page:
        # 先获取首页以知道最新页码
        html_first = fetch(f"{BASE}/bbs/{args.board}/index.html")
        info = parse_board_list(html_first, args.board)
        newest = info["pages"]["newest"]
        if newest is None:
            return {"error": "无法获取分页信息"}
        page = min(args.page, newest)
        url = f"{BASE}/bbs/{args.board}/index{page}.html"
    else:
        url = f"{BASE}/bbs/{args.board}/index.html"

    html = fetch(url)
    return parse_board_list(html, args.board)


def cmd_search(args):
    q = urllib.parse.quote(args.query)
    params = f"q={q}"
    if args.page:
        params += f"&page={args.page}"
    url = f"{BASE}/bbs/{args.board}/search?{params}"
    html = fetch(url)
    result = parse_search(html, args.board)
    if args.limit and "articles" in result:
        result["articles"] = result["articles"][: args.limit]
    result["query"] = args.query
    return result


def cmd_article(args):
    target = args.target
    if target.startswith("/"):
        url = BASE + target
    elif target.startswith("http"):
        url = target
    else:
        url = f"{BASE}/bbs/{args.board}/{target}" if hasattr(args, 'board') and args.board else BASE + target

    html = fetch(url)
    return parse_article(html)


def cmd_allposts(args):
    if args.page:
        url = f"{BASE}/bbs/ALLPOST/index{args.page}.html"
    else:
        url = f"{BASE}/bbs/ALLPOST/index.html"

    html = fetch(url)
    return parse_board_list(html, "ALLPOST")


def cmd_categories(args):
    html = fetch(f"{BASE}/cls/1")
    return parse_categories(html)


def main():
    parser = argparse.ArgumentParser(description="PTT 数据接口")
    sub = parser.add_subparsers(dest="command", required=True)

    # hotboards
    p = sub.add_parser("hotboards", help="热门看板列表")
    p.add_argument("--limit", type=int, default=None, help="限制返回数量")

    # board-list
    p = sub.add_parser("board-list", help="看板文章列表")
    p.add_argument("board", help="看板名称，如 Gossiping")
    p.add_argument("--page", type=int, default=None, help="页码（省略则为最新页）")

    # search
    p = sub.add_parser("search", help="搜索文章")
    p.add_argument("board", help="看板名称")
    p.add_argument("query", help="搜索条件，支持: keyword / author:xxx / title:xxx / recommend:N")
    p.add_argument("--limit", type=int, default=None, help="限制返回数量")
    p.add_argument("--page", type=int, default=None, help="搜索结果页码")

    # article
    p = sub.add_parser("article", help="文章详情")
    p.add_argument("target", help="文章 URL、路径或文件名")

    # allposts
    p = sub.add_parser("allposts", help="全站最新文章")
    p.add_argument("--page", type=int, default=None, help="页码")

    # categories
    p = sub.add_parser("categories", help="分类看板")

    args = parser.parse_args()

    try:
        if args.command == "hotboards":
            data = cmd_hotboards(args)
        elif args.command == "board-list":
            data = cmd_board_list(args)
        elif args.command == "search":
            data = cmd_search(args)
        elif args.command == "article":
            data = cmd_article(args)
        elif args.command == "allposts":
            data = cmd_allposts(args)
        elif args.command == "categories":
            data = cmd_categories(args)
        else:
            data = {"error": f"未知命令: {args.command}"}

        print(json.dumps(data, ensure_ascii=False, indent=2))
    except urllib.error.HTTPError as e:
        print(json.dumps({"error": f"HTTP {e.code}: {e.reason}"}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
