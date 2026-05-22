#!/usr/bin/env python3
"""GitHub Helper 技能 - gh CLI 操作封装"""

import argparse
import os
import subprocess
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).parent.parent
BUNDLED_GH = SKILL_DIR / "bin" / "gh"

def get_gh_path():
    """获取可用的 gh 路径"""
    # 优先使用系统 gh
    if subprocess.run(["which", "gh"], capture_output=True).returncode == 0:
        return "gh"
    # 回退到内置 gh
    if BUNDLED_GH.exists():
        return str(BUNDLED_GH)
    print("错误：未找到 gh CLI", file=sys.stderr)
    print(f"请运行: {SKILL_DIR}/scripts/setup_gh.sh", file=sys.stderr)
    sys.exit(1)

def run_gh(args, check=True):
    """执行 gh 命令"""
    gh = get_gh_path()
    cmd = [gh] + args
    print(f"执行: {' '.join(cmd)}", file=sys.stderr)
    result = subprocess.run(cmd, capture_output=True, text=True)
    
    if result.stdout:
        print(result.stdout)
    if result.stderr:
        print(result.stderr, file=sys.stderr)
    
    if check and result.returncode != 0:
        sys.exit(result.returncode)
    return result.returncode

def cmd_repo_create(args):
    """创建仓库"""
    gh_args = ["repo", "create", args.name]
    if args.private:
        gh_args.append("--private")
    else:
        gh_args.append("--public")
    if args.description:
        gh_args.extend(["--description", args.description])
    if args.readme:
        gh_args.append("--add-readme")
    if args.gitignore:
        gh_args.extend(["--gitignore", args.gitignore])
    if args.license:
        gh_args.extend(["--license", args.license])
    return run_gh(gh_args)

def cmd_repo_fork(args):
    """Fork 仓库"""
    gh_args = ["repo", "fork", args.repo]
    if args.org:
        gh_args.extend(["--org", args.org])
    if args.clone:
        gh_args.append("--clone")
    return run_gh(gh_args)

def cmd_repo_delete(args):
    """删除仓库"""
    if not args.yes:
        print(f"⚠️  警告：即将删除仓库 {args.repo}", file=sys.stderr)
        print("请添加 --yes 确认删除", file=sys.stderr)
        sys.exit(1)
    return run_gh(["repo", "delete", args.repo, "--yes"])

def cmd_issue_create(args):
    """创建 Issue"""
    gh_args = ["issue", "create", "--repo", args.repo, "--title", args.title]
    if args.body:
        gh_args.extend(["--body", args.body])
    elif args.body_file:
        gh_args.extend(["--body-file", args.body_file])
    if args.label:
        gh_args.extend(["--label", ",".join(args.label)])
    if args.assignee:
        gh_args.extend(["--assignee", args.assignee])
    return run_gh(gh_args)

def cmd_issue_view(args):
    """查看 Issue"""
    return run_gh(["issue", "view", str(args.number), "--repo", args.repo])

def cmd_issue_close(args):
    """关闭 Issue"""
    return run_gh(["issue", "close", str(args.number), "--repo", args.repo])

def cmd_issue_comment(args):
    """评论 Issue"""
    return run_gh(["issue", "comment", str(args.number), "--repo", args.repo, "--body", args.body])

def cmd_pr_create(args):
    """创建 Pull Request"""
    gh_args = ["pr", "create", "--repo", args.repo, "--title", args.title]
    if args.body:
        gh_args.extend(["--body", args.body])
    if args.head:
        gh_args.extend(["--head", args.head])
    if args.base:
        gh_args.extend(["--base", args.base])
    if args.draft:
        gh_args.append("--draft")
    if args.label:
        gh_args.extend(["--label", ",".join(args.label)])
    return run_gh(gh_args)

def cmd_release_create(args):
    """创建 Release"""
    gh_args = ["release", "create", args.tag, "--repo", args.repo]
    if args.title:
        gh_args.extend(["--title", args.title])
    if args.notes:
        gh_args.extend(["--notes", args.notes])
    elif args.notes_file:
        gh_args.extend(["--notes-file", args.notes_file])
    if args.draft:
        gh_args.append("--draft")
    if args.prerelease:
        gh_args.append("--prerelease")
    if args.files:
        gh_args.extend(args.files)
    return run_gh(gh_args)

def cmd_webhook_list(args):
    """列出 Webhook"""
    return run_gh(["api", f"repos/{args.repo}/hooks"])

def cmd_webhook_create(args):
    """创建 Webhook"""
    gh_args = [
        "api", f"repos/{args.repo}/hooks", "-X", "POST",
        "-f", f"url={args.url}",
        "-f", "content_type=json"
    ]
    for event in args.events:
        gh_args.extend(["-F", f"events[]={event}"])
    if args.secret:
        gh_args.extend(["-f", f"secret={args.secret}"])
    gh_args.extend(["-F", "active=true"])
    return run_gh(gh_args)

def cmd_api(args):
    """通用 API 调用"""
    gh_args = ["api", args.endpoint]
    if args.method:
        gh_args.extend(["-X", args.method])
    for field in args.fields or []:
        gh_args.extend(["-f", field])
    if args.paginate:
        gh_args.append("--paginate")
    return run_gh(gh_args)

def main():
    parser = argparse.ArgumentParser(description="GitHub Helper - gh CLI 封装")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # repo create
    p = subparsers.add_parser("repo-create", help="创建仓库")
    p.add_argument("name", help="仓库名称 (owner/repo 或 repo)")
    p.add_argument("--private", action="store_true", help="私有仓库")
    p.add_argument("--description", help="仓库描述")
    p.add_argument("--readme", action="store_true", help="添加 README")
    p.add_argument("--gitignore", help=".gitignore 模板 (如 Python, Node)")
    p.add_argument("--license", help="License 模板 (如 MIT, Apache-2.0)")
    p.set_defaults(func=cmd_repo_create)

    # repo fork
    p = subparsers.add_parser("repo-fork", help="Fork 仓库")
    p.add_argument("repo", help="仓库名 (owner/repo)")
    p.add_argument("--org", help="Fork 到指定组织")
    p.add_argument("--clone", action="store_true", help="Fork 后克隆")
    p.set_defaults(func=cmd_repo_fork)

    # repo delete
    p = subparsers.add_parser("repo-delete", help="删除仓库")
    p.add_argument("repo", help="仓库名 (owner/repo)")
    p.add_argument("--yes", action="store_true", help="确认删除")
    p.set_defaults(func=cmd_repo_delete)

    # issue create
    p = subparsers.add_parser("issue-create", help="创建 Issue")
    p.add_argument("--repo", required=True, help="仓库名 (owner/repo)")
    p.add_argument("--title", required=True, help="Issue 标题")
    p.add_argument("--body", help="Issue 内容")
    p.add_argument("--body-file", help="从文件读取内容")
    p.add_argument("--label", action="append", help="标签（可重复）")
    p.add_argument("--assignee", help="指派用户")
    p.set_defaults(func=cmd_issue_create)

    # issue view
    p = subparsers.add_parser("issue-view", help="查看 Issue")
    p.add_argument("--repo", required=True, help="仓库名")
    p.add_argument("number", type=int, help="Issue 编号")
    p.set_defaults(func=cmd_issue_view)

    # issue close
    p = subparsers.add_parser("issue-close", help="关闭 Issue")
    p.add_argument("--repo", required=True, help="仓库名")
    p.add_argument("number", type=int, help="Issue 编号")
    p.set_defaults(func=cmd_issue_close)

    # issue comment
    p = subparsers.add_parser("issue-comment", help="评论 Issue")
    p.add_argument("--repo", required=True, help="仓库名")
    p.add_argument("number", type=int, help="Issue 编号")
    p.add_argument("--body", required=True, help="评论内容")
    p.set_defaults(func=cmd_issue_comment)

    # pr create
    p = subparsers.add_parser("pr-create", help="创建 Pull Request")
    p.add_argument("--repo", required=True, help="仓库名")
    p.add_argument("--title", required=True, help="PR 标题")
    p.add_argument("--body", help="PR 描述")
    p.add_argument("--head", help="源分支")
    p.add_argument("--base", help="目标分支", default="main")
    p.add_argument("--draft", action="store_true", help="草稿 PR")
    p.add_argument("--label", action="append", help="标签（可重复）")
    p.set_defaults(func=cmd_pr_create)

    # release create
    p = subparsers.add_parser("release-create", help="创建 Release")
    p.add_argument("--repo", required=True, help="仓库名")
    p.add_argument("tag", help="标签名 (如 v1.0.0)")
    p.add_argument("--title", help="Release 标题")
    p.add_argument("--notes", help="发布说明")
    p.add_argument("--notes-file", help="从文件读取说明")
    p.add_argument("--draft", action="store_true", help="草稿模式")
    p.add_argument("--prerelease", action="store_true", help="预发布")
    p.add_argument("files", nargs="*", help="上传的文件")
    p.set_defaults(func=cmd_release_create)

    # webhook list
    p = subparsers.add_parser("webhook-list", help="列出 Webhook")
    p.add_argument("--repo", required=True, help="仓库名")
    p.set_defaults(func=cmd_webhook_list)

    # webhook create
    p = subparsers.add_parser("webhook-create", help="创建 Webhook")
    p.add_argument("--repo", required=True, help="仓库名")
    p.add_argument("--url", required=True, help="Webhook URL")
    p.add_argument("--events", action="append", default=["push"], help="事件类型（可重复）")
    p.add_argument("--secret", help="Webhook 密钥")
    p.set_defaults(func=cmd_webhook_create)

    # api
    p = subparsers.add_parser("api", help="通用 API 调用")
    p.add_argument("endpoint", help="API 端点 (如 repos/owner/repo)")
    p.add_argument("--method", help="HTTP 方法", default="GET")
    p.add_argument("--fields", "-f", action="append", help="表单字段 (key=value)")
    p.add_argument("--paginate", action="store_true", help="自动分页")
    p.set_defaults(func=cmd_api)

    args = parser.parse_args()
    args.func(args)

if __name__ == "__main__":
    main()
