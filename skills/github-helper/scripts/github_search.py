#!/usr/bin/env python3
"""GitHub search skill — search repos, code, issues, trending, repo info, user info."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import textwrap
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode, quote

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

API_BASE = "https://api.github.com"
USER_AGENT = "UgkClawGitHubSearch/1.0"
TIMEOUT = 15
DEFAULT_LIMIT = 10
MAX_LIMIT = 50

_TOKEN: str | None = None


def get_token() -> str | None:
    global _TOKEN
    if _TOKEN is None:
        _TOKEN = os.environ.get("GITHUB_TOKEN") or None
    return _TOKEN


def build_headers() -> dict[str, str]:
    headers: dict[str, str] = {"User-Agent": USER_AGENT, "Accept": "application/vnd.github.v3+json"}
    token = get_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def fetch_json(url: str) -> dict[str, Any]:
    req = urllib.request.Request(url, headers=build_headers())
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body)
    except urllib.error.HTTPError as exc:
        status = exc.code
        try:
            detail = json.loads(exc.read().decode("utf-8"))
            msg = detail.get("message", "")
        except Exception:
            msg = ""
        if status == 401:
            hint = "GitHub API 认证失败。如已设置 GITHUB_TOKEN，请检查其有效性。"
            raise RuntimeError(f"GitHub API 401: {msg or hint}") from exc
        if status == 403:
            body_403 = exc.read().decode("utf-8", errors="replace")
            # Check if it's rate limiting or just forbidden
            if "rate limit" in body_403.lower() or "api rate limit" in body_403.lower():
                hint = "API 限流已达上限。如未设置 GITHUB_TOKEN，建议设置后可提升到 5000 次/小时。"
            else:
                hint = "访问被拒绝（403），可能仓库/资源为私有。"
            raise RuntimeError(f"GitHub API 403: {msg or hint}") from exc
        if status == 404:
            raise RuntimeError(f"GitHub API 404: 资源不存在。检查仓库名/用户名是否正确。") from exc
        if status == 422:
            raise RuntimeError(f"GitHub API 422 参数错误: {msg}") from exc
        if status == 429:
            hint = "请求过于频繁。如未设置 GITHUB_TOKEN，建议设置以提升限流。"
            raise RuntimeError(f"GitHub API 429 限流: {msg or hint}") from exc
        raise RuntimeError(f"GitHub API HTTP {status}: {msg or '未知错误'}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"连接 GitHub API 失败: {exc.reason}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"GitHub API 返回内容不是有效 JSON: {exc}") from exc


def fetch_text(url: str) -> str:
    req = urllib.request.Request(url, headers=build_headers())
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return ""
        raise


def positive_int(v: str) -> int:
    n = int(v)
    if n <= 0:
        raise argparse.ArgumentTypeError("必须是正整数")
    return n


def fmt_time(iso_str: str | None) -> str:
    if not iso_str:
        return "未知"
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d")
    except ValueError:
        return iso_str[:10]


def fmt_time_full(iso_str: str | None) -> str:
    if not iso_str:
        return "未知"
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d %H:%M:%S")
    except ValueError:
        return iso_str


def fmt_dt(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d")


def truncate(text: str, limit: int = 200) -> str:
    clean = " ".join(text.split())
    if not clean:
        return "（无）"
    return clean[:limit] + "..." if len(clean) > limit else clean


def rate_limit_info() -> str:
    token = get_token()
    if token:
        return "已设置 GITHUB_TOKEN，限流 5000 次/小时"
    return "未设置 GITHUB_TOKEN，限流 60 次/小时（建议设置以提升到 5000 次/小时）"


# ─── Subcommand: search-repos ────────────────────────────────────────────────


def cmd_search_repos(args: argparse.Namespace) -> int:
    keyword = args.keyword.strip()
    if not keyword:
        print("错误：关键词不能为空。", file=sys.stderr)
        return 1

    q_parts = [keyword]
    if args.lang:
        q_parts.append(f"language:{quote(args.lang, safe='')}")
    if args.min_stars is not None:
        q_parts.append(f"stars:>={args.min_stars}")
    if args.max_stars is not None:
        q_parts.append(f"stars:<={args.max_stars}")

    query = " ".join(q_parts)
    params = {
        "q": query,
        "sort": args.sort,
        "order": args.order,
        "per_page": str(min(args.limit, MAX_LIMIT)),
    }
    url = f"{API_BASE}/search/repositories?{urlencode(params)}"

    try:
        payload = fetch_json(url)
    except RuntimeError as exc:
        print(f"仓库搜索失败：{exc}", file=sys.stderr)
        return 2

    items = payload.get("items", [])
    total = payload.get("total_count", 0)

    lines = ["GitHub 仓库搜索结果", f"关键词：{keyword}"]
    if args.lang:
        lines.append(f"语言：{args.lang}")
    if args.min_stars is not None:
        lines.append(f"最低 Star：{args.min_stars}")
    if args.max_stars is not None:
        lines.append(f"最高 Star：{args.max_stars}")
    lines.append(f"排序：{args.sort} {args.order}")
    lines.append(f"查询 URL：{url}")
    lines.append(f"限流状态：{rate_limit_info()}")
    lines.append("")

    if total == 0:
        lines.append(f"结果概览：未找到匹配的仓库。")
        print("\n".join(lines))
        return 0

    limit = min(args.limit, len(items))
    lines.append(f"共找到 {total:,} 个仓库，显示前 {limit} 个")
    lines.append("")

    for idx, item in enumerate(items[:limit], start=1):
        name = item.get("full_name", "unknown")
        stars = item.get("stargazers_count", 0)
        desc = item.get("description") or "（无描述）"
        lang = item.get("language") or "N/A"
        forks = item.get("forks_count", 0)
        issues = item.get("open_issues_count", 0)
        topics = item.get("topics", [])
        updated = fmt_time(item.get("updated_at"))
        license_name = ""
        license_info = item.get("license")
        if license_info:
            license_name = license_info.get("spdx_id") or license_info.get("name", "")
        repo_url = item.get("html_url", "")

        lines.append(f"{idx}. {name} ⭐ {stars:,}")
        lines.append(f"   描述：{truncate(desc, 150)}")
        lines.append(f"   语言：{lang} | Forks：{forks:,} | Issues：{issues}")
        lines.append(f"   License：{license_name or 'N/A'} | 更新：{updated}")
        if topics:
            lines.append(f"   Topics：{', '.join(topics[:5])}")
        lines.append(f"   URL：{repo_url}")
        lines.append("")

    print("\n".join(lines))
    return 0


# ─── Subcommand: repo-info ───────────────────────────────────────────────────


def cmd_repo_info(args: argparse.Namespace) -> int:
    repo = args.repo.strip()
    if "/" not in repo:
        print("错误：仓库名格式应为 owner/repo，例如 vercel/next.js", file=sys.stderr)
        return 1

    show_all = args.all or not (args.basic or args.readme or args.releases or args.license or args.contributors)
    limit = min(args.limit, MAX_LIMIT)
    lines = [f"GitHub 仓库信息", f"仓库：{repo}", f"URL：https://github.com/{repo}", ""]

    try:
        # Fetch basic info
        data = fetch_json(f"{API_BASE}/repos/{repo}")
    except RuntimeError as exc:
        print(f"获取仓库信息失败：{exc}", file=sys.stderr)
        return 2

    if show_all or args.basic:
        stars = data.get("stargazers_count", 0)
        forks = data.get("forks_count", 0)
        lang = data.get("language") or "N/A"
        desc = data.get("description") or "（无描述）"
        topics = data.get("topics", [])
        created = fmt_time(data.get("created_at"))
        updated = fmt_time(data.get("updated_at"))
        pushed = fmt_time(data.get("pushed_at"))
        license_name = ""
        license_info = data.get("license")
        if license_info:
            license_name = license_info.get("spdx_id") or license_info.get("name", "")
        watchers = data.get("subscribers_count", 0)
        default_branch = data.get("default_branch", "main")
        open_issues = data.get("open_issues_count", 0)
        size_kb = data.get("size", 0)
        size_mb = round(size_kb / 1024, 1) if size_kb else 0
        homepage = data.get("homepage") or "（无）"
        archived = data.get("archived", False)
        disabled = data.get("disabled", False)

        lines.append("基本信息")
        lines.append(f"  ⭐ Stars：{stars:,} | 🍴 Forks：{forks:,} | 👁 Watchers：{watchers:,}")
        lines.append(f"  语言：{lang} | License：{license_name or 'N/A'}")
        lines.append(f"  Issues：{open_issues} | 默认分支：{default_branch}")
        lines.append(f"  创建：{created} | 更新：{updated} | 推送：{pushed}")
        if size_mb:
            lines.append(f"  仓库大小：{size_mb} MB")
        lines.append(f"  描述：{truncate(desc, 300)}")
        if homepage and homepage != "（无）":
            lines.append(f"  主页：{homepage}")
        if topics:
            lines.append(f"  Topics：{', '.join(topics)}")
        if archived:
            lines.append(f"  ⚠️ 此仓库已被归档")
        if disabled:
            lines.append(f"  ⛔ 此仓库已被禁用")
        lines.append("")

    if show_all or args.license:
        try:
            license_data = fetch_json(f"{API_BASE}/repos/{repo}/license")
            lic_name = license_data.get("license", {}).get("name", "未知")
            lic_spdx = license_data.get("license", {}).get("spdx_id", "")
            lic_url = license_data.get("html_url", "")
            lines.append("许可证信息")
            lines.append(f"  名称：{lic_name} ({lic_spdx})" if lic_spdx else f"  名称：{lic_name}")
            if lic_url:
                lines.append(f"  文件链接：{lic_url}")
            lines.append("")
        except RuntimeError:
            pass

    if show_all or args.readme:
        try:
            readme_data = fetch_json(f"{API_BASE}/repos/{repo}/readme")
            content_b64 = readme_data.get("content", "")
            import base64
            try:
                readme_text = base64.b64decode(content_b64).decode("utf-8")
                readme_text = re.sub(r"\s+", " ", readme_text).strip()
                readme_text = re.sub(r"<!--.*?-->", "", readme_text, flags=re.DOTALL)
                readme_text = re.sub(r"```[\s\S]*?```", "", readme_text)
                readme_text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", readme_text)
                lines.append("README 摘要")
                lines.append(f"  {truncate(readme_text, 500)}")
                lines.append(f"  完整 README：https://github.com/{repo}#readme")
                lines.append("")
            except Exception:
                lines.append("README：（解码失败）")
                lines.append("")
        except RuntimeError:
            lines.append("README：（无 README 文件或无法访问）")
            lines.append("")

    if show_all or args.releases:
        try:
            releases = fetch_json(f"{API_BASE}/repos/{repo}/releases?per_page={limit}")
            if isinstance(releases, list) and releases:
                lines.append(f"最新 Release（前 {len(releases)} 个）")
                for rel in releases:
                    tag = rel.get("tag_name", "")
                    name = rel.get("name") or tag
                    published = fmt_time(rel.get("published_at"))
                    prerelease = " 🧪" if rel.get("prerelease") else ""
                    rel_url = rel.get("html_url", "")
                    body = (rel.get("body") or "")[:200].strip()
                    lines.append(f"  {tag} — {name}{prerelease}")
                    lines.append(f"    日期：{published} | URL：{rel_url}")
                    if body:
                        lines.append(f"    摘要：{truncate(body, 150)}")
                lines.append("")
            else:
                lines.append("Release：（暂无发布版本）")
                lines.append("")
        except RuntimeError:
            lines.append("Release：（获取失败）")
            lines.append("")

    if show_all or args.contributors:
        try:
            contribs = fetch_json(f"{API_BASE}/repos/{repo}/contributors?per_page={limit}")
            if isinstance(contribs, list) and contribs:
                lines.append(f"贡献者（前 {len(contribs)} 位）")
                for c in contribs:
                    login = c.get("login", "unknown")
                    contrib_count = c.get("contributions", 0)
                    avatar = c.get("html_url", "")
                    lines.append(f"  {login} — {contrib_count} commits | URL：{avatar}")
                lines.append("")
            else:
                lines.append("贡献者：（暂无数据）")
                lines.append("")
        except RuntimeError:
            lines.append("贡献者：（获取失败）")
            lines.append("")

    print("\n".join(lines))
    return 0


# ─── Subcommand: search-issues ───────────────────────────────────────────────


def cmd_search_issues(args: argparse.Namespace) -> int:
    keyword = args.keyword.strip() if args.keyword else ""
    q_parts = []

    if keyword:
        q_parts.append(keyword)
    if args.repo:
        q_parts.append(f"repo:{args.repo}")
    if args.label:
        for lbl in args.label:
            q_parts.append(f"label:\"{lbl}\"")

    if not q_parts:
        print("错误：必须提供关键词或仓库名。", file=sys.stderr)
        return 1

    query = " ".join(q_parts)
    params: dict[str, str] = {
        "q": query,
        "sort": args.sort,
        "order": args.order,
        "per_page": str(min(args.limit, MAX_LIMIT)),
    }
    if args.state and args.state != "all":
        params["q"] += f" state:{args.state}"
    if args.issue_type and args.issue_type != "all":
        params["q"] += f" type:{args.issue_type}"

    url = f"{API_BASE}/search/issues?{urlencode(params)}"

    try:
        payload = fetch_json(url)
    except RuntimeError as exc:
        print(f"Issue 搜索失败：{exc}", file=sys.stderr)
        return 2

    items = payload.get("items", [])
    total = payload.get("total_count", 0)

    lines = ["GitHub Issue / PR 搜索结果"]
    if args.repo:
        lines.append(f"仓库：{args.repo}")
    if keyword:
        lines.append(f"关键词：{keyword}")
    lines.append(f"状态：{args.state or 'all'} | 类型：{args.issue_type or 'all'}")
    lines.append(f"排序：{args.sort} {args.order}")
    lines.append(f"查询 URL：{url}")
    lines.append(f"限流状态：{rate_limit_info()}")
    lines.append("")

    if total == 0:
        lines.append("结果概览：未找到匹配的 Issue 或 PR。")
        print("\n".join(lines))
        return 0

    limit = min(args.limit, len(items))
    lines.append(f"共找到 {total:,} 条结果，显示前 {limit} 个")
    lines.append("")

    for idx, item in enumerate(items[:limit], start=1):
        num = item.get("number", 0)
        title = item.get("title", "（无标题）")
        state = item.get("state", "unknown")
        pull_request = item.get("pull_request") is not None
        item_type = "🔀 PR" if pull_request else "🐛 Issue"
        state_icon = "🟢 Open" if state == "open" else "🔴 Closed"
        author = item.get("user", {}).get("login", "unknown")
        created = fmt_time_full(item.get("created_at"))
        comments = item.get("comments", 0)
        labels = [lbl.get("name", "") for lbl in item.get("labels", [])]
        item_url = item.get("html_url", "")
        body = (item.get("body") or "")[:150].strip()

        lines.append(f"{idx}. #{num} | {title}")
        lines.append(f"   {state_icon} | {item_type}")
        lines.append(f"   作者：{author} | 创建：{created} | 评论：{comments}")
        if labels:
            lines.append(f"   标签：{', '.join(labels)}")
        if body:
            lines.append(f"   摘要：{truncate(body, 120)}")
        lines.append(f"   URL：{item_url}")
        lines.append("")

    print("\n".join(lines))
    return 0


# ─── Subcommand: search-code ────────────────────────────────────────────────


def cmd_search_code(args: argparse.Namespace) -> int:
    keyword = args.keyword.strip()
    if not keyword:
        print("错误：代码搜索关键词不能为空。", file=sys.stderr)
        return 1

    q_parts = [keyword]
    if args.lang:
        q_parts.append(f"language:{quote(args.lang, safe='')}")
    if args.owner:
        q_parts.append(f"user:{args.owner}")
    if args.repo:
        q_parts.append(f"repo:{args.repo}")
    if args.path:
        q_parts.append(f"path:{args.path}")

    query = " ".join(q_parts)
    params = {
        "q": query,
        "per_page": str(min(args.limit, MAX_LIMIT)),
    }
    url = f"{API_BASE}/search/code?{urlencode(params)}"

    try:
        payload = fetch_json(url)
    except RuntimeError as exc:
        msg = str(exc)
        if "401" in msg or "403" in msg:
            print(f"代码搜索需要 GitHub API 认证。\n"
                  f"GitHub 的代码搜索接口要求认证（即使搜索公开数据）。\n"
                  f"请设置 GITHUB_TOKEN 环境变量后再试。\n"
                  f"详细：{msg}", file=sys.stderr)
        else:
            print(f"代码搜索失败：{exc}", file=sys.stderr)
        return 2

    items = payload.get("items", [])
    total = payload.get("total_count", 0)

    lines = ["GitHub 代码搜索结果", f"关键词：{keyword}"]
    if args.lang:
        lines.append(f"语言：{args.lang}")
    if args.owner:
        lines.append(f"用户/组织：{args.owner}")
    if args.repo:
        lines.append(f"仓库：{args.repo}")
    if args.path:
        lines.append(f"路径：{args.path}")
    lines.append(f"查询 URL：{url}")
    lines.append(f"限流状态：{rate_limit_info()}")
    lines.append("")

    if total == 0:
        lines.append("结果概览：未找到匹配的代码片段。")
        print("\n".join(lines))
        return 0

    limit = min(args.limit, len(items))
    lines.append(f"共找到 {total:,} 条结果，显示前 {limit} 个")
    lines.append("")

    for idx, item in enumerate(items[:limit], start=1):
        filename = item.get("name", "unknown")
        path = item.get("path", "unknown")
        repo_full = item.get("repository", {}).get("full_name", "unknown")
        html_url = item.get("html_url", "")
        git_url = item.get("git_url", "")

        lines.append(f"{idx}. {filename}")
        lines.append(f"   仓库：{repo_full}")
        lines.append(f"   路径：{path}")
        lines.append(f"   URL：{html_url}")
        lines.append("")

    print("\n".join(lines))
    return 0


# ─── Subcommand: trending ────────────────────────────────────────────────────


def cmd_trending(args: argparse.Namespace) -> int:
    since = args.since.lower()
    since_days = {"daily": 1, "weekly": 7, "monthly": 30}
    days = since_days.get(since, 7)

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    date_str = fmt_dt(cutoff)

    q_parts = [f"created:>{date_str}"]
    if args.lang:
        q_parts.append(f"language:{quote(args.lang, safe='')}")

    # Exclude archived repos
    q_parts.append("archived:false")

    query = " ".join(q_parts)
    params = {
        "q": query,
        "sort": "stars",
        "order": "desc",
        "per_page": str(min(args.limit, MAX_LIMIT)),
    }
    url = f"{API_BASE}/search/repositories?{urlencode(params)}"

    try:
        payload = fetch_json(url)
    except RuntimeError as exc:
        print(f"获取 Trending 失败：{exc}", file=sys.stderr)
        return 2

    items = payload.get("items", [])
    total = payload.get("total_count", 0)

    since_label = {"daily": "今日", "weekly": "本周", "monthly": "本月"}.get(since, "本周")

    lines = [f"GitHub Trending — {since_label}"]
    if args.lang:
        lines.append(f"语言：{args.lang}")
    lines.append(f"查询 URL：{url}")
    lines.append(f"限流状态：{rate_limit_info()}")
    lines.append("")

    if not items:
        lines.append("未获取到趋势项目。")
        print("\n".join(lines))
        return 0

    limit = min(args.limit, len(items))
    lines.append(f"共 {total:,} 个近期新项目，显示前 {limit} 个")
    lines.append("")

    for idx, item in enumerate(items[:limit], start=1):
        name = item.get("full_name", "unknown")
        stars = item.get("stargazers_count", 0)
        desc = item.get("description") or "（无描述）"
        lang = item.get("language") or "N/A"
        forks = item.get("forks_count", 0)
        created = fmt_time(item.get("created_at"))
        repo_url = item.get("html_url", "")

        lines.append(f"{idx}. {name} ⭐ {stars:,}")
        lines.append(f"   描述：{truncate(desc, 150)}")
        lines.append(f"   语言：{lang} | Forks：{forks:,}")
        lines.append(f"   创建：{created}")
        lines.append(f"   URL：{repo_url}")
        lines.append("")

    print("\n".join(lines))
    return 0


# ─── Subcommand: user-info ──────────────────────────────────────────────────


def cmd_user_info(args: argparse.Namespace) -> int:
    username = args.username.strip()
    if not username:
        print("错误：用户名不能为空。", file=sys.stderr)
        return 1

    try:
        data = fetch_json(f"{API_BASE}/users/{username}")
    except RuntimeError as exc:
        print(f"获取用户信息失败：{exc}", file=sys.stderr)
        return 2

    login = data.get("login", username)
    name = data.get("name") or login
    avatar_url = data.get("avatar_url", "")
    bio = data.get("bio") or "（无简介）"
    company = data.get("company") or "N/A"
    location = data.get("location") or "N/A"
    blog = data.get("blog") or "N/A"
    email = data.get("email") or "（未公开）"
    twitter = data.get("twitter_username") or "（未设置）"
    user_type = data.get("type", "User")  # "User" or "Organization"
    public_repos = data.get("public_repos", 0)
    public_gists = data.get("public_gists", 0)
    followers = data.get("followers", 0)
    following = data.get("following", 0)
    created = fmt_time(data.get("created_at"))
    updated = fmt_time(data.get("updated_at"))
    html_url = data.get("html_url", f"https://github.com/{username}")
    hireable = data.get("hireable", False)

    lines = [
        f"GitHub {'用户' if user_type == 'User' else '组织'}信息",
        f"{'用户' if user_type == 'User' else '组织'}名：{login}",
        f"名称：{name}",
        f"URL：{html_url}",
        "",
        "基本信息",
        f"  简介：{truncate(bio, 300)}",
        f"  公司：{company} | 位置：{location}",
        f"  博客：{blog}",
        f"  邮箱：{email} | Twitter：@{twitter if twitter != '（未设置）' else 'N/A'}",
        f"  公开仓库：{public_repos} | 公开 Gist：{public_gists}",
        f"  关注者：{followers:,} | 关注中：{following:,}",
        f"  注册时间：{created} | 最后更新：{updated}",
    ]
    if hireable:
        lines.append(f"  状态：可雇佣 ✅")
    lines.append("")

    if args.repos:
        try:
            repos = fetch_json(f"{API_BASE}/users/{username}/repos?sort=updated&per_page={min(args.limit, MAX_LIMIT)}&type=public")
            if isinstance(repos, list) and repos:
                limit = min(len(repos), args.limit)
                lines.append(f"公开仓库（最近更新前 {limit} 个）")
                for r in repos[:limit]:
                    rname = r.get("full_name", r.get("name", "unknown"))
                    rstars = r.get("stargazers_count", 0)
                    rlang = r.get("language") or "N/A"
                    rdesc = r.get("description") or "（无描述）"
                    rurl = r.get("html_url", "")
                    rfork = r.get("fork", False)
                    fork_tag = " (Fork)" if rfork else ""
                    lines.append(f"  {rname} ⭐ {rstars:,} | {rlang}{fork_tag}")
                    lines.append(f"    {truncate(rdesc, 120)}")
                    lines.append(f"    {rurl}")
                lines.append("")
            else:
                lines.append("公开仓库：（暂无）")
                lines.append("")
        except RuntimeError as exc:
            lines.append(f"公开仓库：（获取失败：{exc}）")
            lines.append("")

    print("\n".join(lines))
    return 0


# ─── Main CLI ───────────────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(
        description="GitHub Search Skill — 搜索仓库、代码、Issue、Trending，查看仓库/用户信息",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""
            使用示例：
              python3 github_search.py search-repos --keyword "react table" --lang typescript --min-stars 1000
              python3 github_search.py repo-info vercel/next.js --all
              python3 github_search.py search-issues --repo vercel/next.js --keyword "hydration" --state open
              python3 github_search.py search-code --keyword "useEffect" --lang javascript
              python3 github_search.py trending --lang python --since weekly
              python3 github_search.py user-info torvalds --repos --limit 10
        """),
    )
    parser.add_argument("--dry-run", action="store_true", help="输出请求信息但不发送网络请求")

    subparsers = parser.add_subparsers(dest="command", required=True, help="子命令")

    # search-repos
    p = subparsers.add_parser("search-repos", help="搜索 GitHub 仓库")
    p.add_argument("--keyword", required=True, help="搜索关键词")
    p.add_argument("--lang", help="编程语言过滤")
    p.add_argument("--min-stars", type=int, help="最低 Star 数")
    p.add_argument("--max-stars", type=int, help="最高 Star 数")
    p.add_argument("--sort", choices=["stars", "forks", "updated"], default="stars", help="排序字段")
    p.add_argument("--order", choices=["desc", "asc"], default="desc", help="排序方向")
    p.add_argument("--limit", type=positive_int, default=DEFAULT_LIMIT, help=f"返回条数，默认 {DEFAULT_LIMIT}，最大 {MAX_LIMIT}")

    # repo-info
    p = subparsers.add_parser("repo-info", help="查看仓库详细信息")
    p.add_argument("repo", help="仓库名，格式 owner/repo")
    p.add_argument("--basic", action="store_true", help="基本信息")
    p.add_argument("--readme", action="store_true", help="README 摘要")
    p.add_argument("--releases", action="store_true", help="最新 Release")
    p.add_argument("--license", action="store_true", help="许可证信息")
    p.add_argument("--contributors", action="store_true", help="贡献者列表")
    p.add_argument("--all", action="store_true", help="全部信息（默认）")
    p.add_argument("--limit", type=positive_int, default=DEFAULT_LIMIT, help=f"Release/Contributor 返回条数，默认 {DEFAULT_LIMIT}")

    # search-issues
    p = subparsers.add_parser("search-issues", help="搜索 Issue / Pull Request")
    p.add_argument("--repo", help="仓库名，格式 owner/repo（可选，不指定则全局搜索）")
    p.add_argument("--keyword", help="搜索关键词")
    p.add_argument("--state", choices=["open", "closed", "all"], default="all", help="状态")
    p.add_argument("--type", dest="issue_type", choices=["issue", "pr", "all"], default="all", help="类型")
    p.add_argument("--label", action="append", help="标签过滤（可重复指定）")
    p.add_argument("--sort", choices=["created", "updated", "comments"], default="created", help="排序字段")
    p.add_argument("--order", choices=["desc", "asc"], default="desc", help="排序方向")
    p.add_argument("--limit", type=positive_int, default=DEFAULT_LIMIT, help=f"返回条数，默认 {DEFAULT_LIMIT}，最大 {MAX_LIMIT}")

    # search-code
    p = subparsers.add_parser("search-code", help="搜索 GitHub 代码")
    p.add_argument("--keyword", required=True, help="搜索关键词")
    p.add_argument("--lang", help="编程语言过滤")
    p.add_argument("--owner", help="用户/组织过滤")
    p.add_argument("--repo", help="仓库过滤")
    p.add_argument("--path", help="文件路径过滤")
    p.add_argument("--limit", type=positive_int, default=DEFAULT_LIMIT, help=f"返回条数，默认 {DEFAULT_LIMIT}，最大 {MAX_LIMIT}")

    # trending
    p = subparsers.add_parser("trending", help="GitHub 趋势项目")
    p.add_argument("--lang", help="编程语言过滤")
    p.add_argument("--since", choices=["daily", "weekly", "monthly"], default="weekly", help="时间范围")
    p.add_argument("--limit", type=positive_int, default=15, help=f"返回条数，默认 15，最大 {MAX_LIMIT}")

    # user-info
    p = subparsers.add_parser("user-info", help="查看用户/组织信息")
    p.add_argument("username", help="GitHub 用户名或组织名")
    p.add_argument("--repos", action="store_true", help="同时列出公开仓库")
    p.add_argument("--limit", type=positive_int, default=DEFAULT_LIMIT, help=f"仓库列表条数，默认 {DEFAULT_LIMIT}，最大 {MAX_LIMIT}")

    args = parser.parse_args()

    if args.dry_run:
        print(json.dumps({"command": args.command, **{k: v for k, v in vars(args).items() if k not in ("command", "dry_run") and v is not None}}, ensure_ascii=False, indent=2))
        return 0

    cmds = {
        "search-repos": cmd_search_repos,
        "repo-info": cmd_repo_info,
        "search-issues": cmd_search_issues,
        "search-code": cmd_search_code,
        "trending": cmd_trending,
        "user-info": cmd_user_info,
    }

    handler = cmds.get(args.command)
    if not handler:
        print(f"错误：未知子命令 '{args.command}'", file=sys.stderr)
        return 1

    return handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
