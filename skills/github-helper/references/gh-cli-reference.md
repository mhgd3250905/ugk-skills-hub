# GitHub CLI 管理命令参考

## 脚本路径

```bash
HELPER=/app/runtime/skills-user/github-helper/scripts/gh_helper.py
```

## 仓库管理

### `repo-create` — 创建仓库

```bash
# 创建私有仓库
python3 $HELPER repo-create my-project --private --description "项目描述"

# 创建公开仓库，带 README
python3 $HELPER repo-create my-project --public --readme

# 在组织下创建仓库
python3 $HELPER repo-create my-org/my-project --private

# 带 .gitignore 和 License 模板
python3 $HELPER repo-create my-project --private --gitignore Python --license MIT
```

**参数：**
- `name`：仓库名称（位置参数），格式 `repo` 或 `owner/repo`
- `--private`：私有仓库
- `--public`：公开仓库（默认）
- `--description`：仓库描述
- `--readme`：添加 README
- `--gitignore`：.gitignore 模板（如 Python, Node, Java）
- `--license`：License 模板（如 MIT, Apache-2.0, GPL-3.0）

### `repo-fork` — Fork 仓库

```bash
# Fork 到当前用户
python3 $HELPER repo-fork vercel/next.js

# Fork 到指定组织
python3 $HELPER repo-fork vercel/next.js --org my-org

# Fork 并克隆到本地
python3 $HELPER repo-fork vercel/next.js --clone
```

**参数：**
- `repo`：仓库名（位置参数），格式 `owner/repo`
- `--org`：Fork 到指定组织
- `--clone`：Fork 后克隆到本地

### `repo-delete` — 删除仓库

```bash
# 删除仓库（⚠️ 需用户确认）
python3 $HELPER repo-delete owner/repo --yes
```

**参数：**
- `repo`：仓库名（位置参数），格式 `owner/repo`
- `--yes`：确认删除（必须提供）

> ⚠️ **警告**：删除仓库是不可逆操作，必须先征得用户确认。

## Issue 管理

### `issue-create` — 创建 Issue

```bash
# 基本创建
python3 $HELPER issue-create --repo owner/repo \
  --title "Bug: xxx" \
  --body "详细描述"

# 带标签和指派
python3 $HELPER issue-create --repo owner/repo \
  --title "Feature: xxx" \
  --body "详细描述" \
  --label enhancement \
  --label good-first-issue \
  --assignee "@me"

# 从文件读取内容
python3 $HELPER issue-create --repo owner/repo \
  --title "xxx" \
  --body-file ./issue-body.md
```

**参数：**
- `--repo`：仓库名（必填），格式 `owner/repo`
- `--title`：Issue 标题（必填）
- `--body`：Issue 内容
- `--body-file`：从文件读取内容
- `--label`：标签（可重复使用）
- `--assignee`：指派用户

### `issue-view` — 查看 Issue

```bash
python3 $HELPER issue-view --repo owner/repo 123
```

**参数：**
- `number`：Issue 编号（位置参数）
- `--repo`：仓库名（必填）

### `issue-close` — 关闭 Issue

```bash
python3 $HELPER issue-close --repo owner/repo 123
```

**参数：**
- `number`：Issue 编号（位置参数）
- `--repo`：仓库名（必填）

### `issue-comment` — 评论 Issue

```bash
python3 $HELPER issue-comment --repo owner/repo 123 --body "评论内容"
```

**参数：**
- `number`：Issue 编号（位置参数）
- `--repo`：仓库名（必填）
- `--body`：评论内容（必填）

## Pull Request 管理

### `pr-create` — 创建 Pull Request

```bash
# 基本创建（从当前分支）
python3 $HELPER pr-create --repo owner/repo \
  --title "feat: xxx" \
  --body "PR 描述"

# 指定分支
python3 $HELPER pr-create --repo owner/repo \
  --head feature-branch \
  --base main \
  --title "feat: xxx" \
  --body "PR 描述"

# 草稿 PR
python3 $HELPER pr-create --repo owner/repo \
  --title "WIP: xxx" \
  --draft

# 带标签
python3 $HELPER pr-create --repo owner/repo \
  --title "fix: xxx" \
  --label bug \
  --label urgent
```

**参数：**
- `--repo`：仓库名（必填），格式 `owner/repo`
- `--title`：PR 标题（必填）
- `--body`：PR 描述
- `--head`：源分支
- `--base`：目标分支（默认 main）
- `--draft`：草稿模式
- `--label`：标签（可重复使用）

## Release 管理

### `release-create` — 创建 Release

```bash
# 基本发布
python3 $HELPER release-create --repo owner/repo v1.0.0 \
  --title "Release 1.0.0" \
  --notes "发布说明"

# 从文件读取发布说明
python3 $HELPER release-create --repo owner/repo v1.0.0 \
  --title "Release 1.0.0" \
  --notes-file ./CHANGELOG.md

# 上传附件
python3 $HELPER release-create --repo owner/repo v1.0.0 \
  --title "Release 1.0.0" \
  --notes "发布说明" \
  ./dist/app.zip \
  ./dist/app.tar.gz

# 草稿模式（不立即发布）
python3 $HELPER release-create --repo owner/repo v1.0.0 \
  --draft

# 预发布标记
python3 $HELPER release-create --repo owner/repo v1.0.0-rc1 \
  --prerelease
```

**参数：**
- `tag`：标签名（位置参数），如 v1.0.0
- `--repo`：仓库名（必填），格式 `owner/repo`
- `--title`：Release 标题
- `--notes`：发布说明
- `--notes-file`：从文件读取说明
- `--draft`：草稿模式
- `--prerelease`：预发布标记
- `files`：上传的文件（位置参数，可多个）

## Webhook 管理

### `webhook-list` — 列出 Webhook

```bash
python3 $HELPER webhook-list --repo owner/repo
```

**参数：**
- `--repo`：仓库名（必填）

### `webhook-create` — 创建 Webhook

```bash
python3 $HELPER webhook-create --repo owner/repo \
  --url https://example.com/webhook \
  --events push \
  --events pull_request \
  --secret my-secret-key
```

**参数：**
- `--repo`：仓库名（必填）
- `--url`：Webhook URL（必填）
- `--events`：事件类型（可重复使用，默认 push）
- `--secret`：Webhook 密钥

## 通用 API 调用

### `api` — 调用任意 GitHub REST API

```bash
# GET 请求
python3 $HELPER api repos/owner/repo

# POST 请求
python3 $HELPER api repos/owner/repo/labels \
  --method POST \
  --fields "name=priority:high" \
  --fields "color=d73a4a"

# PATCH 请求
python3 $HELPER api repos/owner/repo \
  --method PATCH \
  --fields "description=新的仓库描述"

# 分页请求
python3 $HELPER api users/username/repos --paginate
```

**参数：**
- `endpoint`：API 端点（位置参数），如 `repos/owner/repo`
- `--method`：HTTP 方法（默认 GET）
- `--fields` / `-f`：表单字段（可重复，格式 `key=value`）
- `--paginate`：自动分页

**常用端点示例：**
- `repos/{owner}/{repo}` — 获取/更新仓库信息
- `repos/{owner}/{repo}/labels` — 管理标签
- `repos/{owner}/{repo}/hooks` — 管理 Webhook
- `users/{username}/repos` — 用户仓库列表
- `orgs/{org}/repos` — 组织仓库列表
- `repos/{owner}/{repo}/commits` — 提交历史
- `repos/{owner}/{repo}/branches` — 分支列表
