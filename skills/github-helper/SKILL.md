---
name: github-helper
description: GitHub 综合技能。检索：搜索仓库、查看仓库信息（README/releases/license/contributors）、搜索 Issues/PRs、搜索代码、获取 Trending、查看用户/组织信息。管理：创建仓库、Fork 仓库、创建 Issue、创建 PR、创建 Release、管理 Webhook。支持显式命令 `/github:...` 触发，也支持自然语言明确提及 GitHub 时自动触发。不要为非 GitHub 网站的问题触发。
---

# github-helper

GitHub 综合技能，覆盖检索和管理两大能力。检索通过 Python 脚本调用 GitHub REST API，管理通过内置的 GitHub CLI (`gh`) 执行。

## 技能目录

```
github-helper/
├── SKILL.md                        ← 你在这里
├── bin/gh                          ← 内置 GitHub CLI 二进制文件（42MB）
├── scripts/
│   ├── github_search.py            ← 检索操作脚本
│   ├── gh_helper.py                ← 管理操作脚本（12 个子命令）
│   └── setup_gh.sh                 ← 环境设置脚本
├── references/
│   ├── search-reference.md         ← 检索命令详细参数和输出示例
│   └── gh-cli-reference.md         ← 管理命令详细参数和示例
└── evals/evals.json                ← 测试用例
```

## 职责边界

### 本技能负责

**检索（REST API）：**
1. 仓库搜索 — 按关键词、语言、Star 数等条件搜索开源项目
2. 仓库详情 — 查看 README、Releases、License、Contributors
3. Issues / PRs 搜索 — 按仓库、关键词、状态、标签搜索
4. 代码搜索 — 按关键词和语言搜索代码片段（需认证）
5. GitHub Trending — 获取每日/每周/每月趋势仓库
6. 用户/组织信息 — 查看公开信息和仓库列表

**管理（gh CLI）：**
7. 创建仓库 — 公开/私有，支持 README、.gitignore、License
8. Fork 仓库 — Fork 到当前用户或指定组织
9. 创建 Issue — 支持标签、指派、从文件读取内容
10. 创建 Pull Request — 支持指定分支、草稿模式、标签
11. 创建 Release — 支持附件上传、草稿、预发布
12. 管理 Webhook — 添加、查看、删除
13. 通用 API 调用 — 任意 GitHub REST API 端点

### 本技能不负责

- 非 GitHub 相关的问题
- 浏览器截图（用 web-access 技能）
- 邮件报告或汇总通知（用 send-email 技能）
- 自动扩展关键词为同义词或翻译

## 触发规则

### 显式命令

```
/github:search repos react table --lang typescript --min-stars 1000
/github:search issues vercel/next.js --keyword "hydration error" --state open
/github:search code "useEffect cleanup" --lang javascript
/github:info vercel/next.js --readme
/github:info vercel/next.js --releases
/github:trending --lang python --since weekly
/github:user torvalds
```

### 自然语言

以下情况可以安全自动触发：

**检索类：**
- "帮我查一下 GitHub 上 react 的虚拟滚动库"
- "找找有没有用 Python 的异步 web 框架"
- "查一下 vercel/next.js 的最新 release 是什么"
- "GitHub 趋势项目有哪些？"
- "看看 torvalds 的 GitHub 主页"
- "搜索一下 react 仓库里关于 hooks 的 open issue"

**管理类：**
- "帮我建一个私有仓库叫 my-project"
- "fork 一下 vercel/next.js"
- "在 myorg/myrepo 创建一个 issue"
- "发布一个 v1.0.0 的 release"
- "给这个仓库加个 webhook"

### 不应触发

- "帮我设计一个 GitHub 查询技能" → 用 site-search-skill-designer
- "打开 GitHub 截图" → 用 web-access
- "GitHub 怎么注册"、"GitHub Copilot 多少钱" → 非操作类问题

## 环境准备

首次使用前运行设置脚本，确保 gh CLI 可用：

```bash
bash /app/runtime/skills-user/github-helper/scripts/setup_gh.sh
```

脚本会自动检测系统 gh，未安装则使用 `bin/gh` 内置二进制。

**认证：** 设置 `GITHUB_TOKEN` 环境变量即可。管理操作必须认证；检索操作中代码搜索也必须认证，其他检索在无 Token 时限流 60 次/小时（有 Token 为 5000 次/小时）。

> ⚠️ **安全提醒**：Token 不要在回复中明文展示给用户。用户提供 token 后，在后台设置即可，回复中只确认「已配置」。

## 执行方式

### 检索操作

```bash
SEARCH=/app/runtime/skills-user/github-helper/scripts/github_search.py
python3 $SEARCH <subcommand> [options]
```

| 子命令 | 用途 | 关键参数 |
|--------|------|----------|
| `search-repos` | 搜索仓库 | `--keyword`, `--lang`, `--min-stars`, `--sort`, `--limit` |
| `repo-info` | 仓库详情 | `owner/repo`, `--basic/--readme/--releases/--license/--contributors/--all` |
| `search-issues` | 搜索 Issue/PR | `--repo`, `--keyword`, `--state`, `--type`, `--label`, `--limit` |
| `search-code` | 搜索代码（需认证） | `--keyword`, `--lang`, `--owner`, `--repo`, `--path` |
| `trending` | 趋势项目 | `--lang`, `--since daily/weekly/monthly`, `--limit` |
| `user-info` | 用户/组织信息 | `username`, `--repos`, `--limit` |

**快速示例：**

```bash
# 搜索 TypeScript 的 React 表格库，Star > 1000
python3 $SEARCH search-repos --keyword "react table" --lang typescript --min-stars 1000

# 查看 next.js 最新 release
python3 $SEARCH repo-info vercel/next.js --releases --limit 3

# 搜索 next.js 中关于 hydration error 的 open issue
python3 $SEARCH search-issues --repo vercel/next.js --keyword "hydration error" --state open

# 本周 Python 趋势
python3 $SEARCH trending --lang python --since weekly

# 查看 torvalds 的用户信息
python3 $SEARCH user-info torvalds --repos --limit 10
```

📖 详细参数和输出格式见 `references/search-reference.md`

### 管理操作

```bash
HELPER=/app/runtime/skills-user/github-helper/scripts/gh_helper.py
python3 $HELPER <command> [options]
```

| 命令 | 用途 | 关键参数 |
|------|------|----------|
| `repo-create` | 创建仓库 | `name`, `--private/--public`, `--description`, `--readme`, `--gitignore`, `--license` |
| `repo-fork` | Fork 仓库 | `repo`, `--org`, `--clone` |
| `repo-delete` | 删除仓库（⚠️ 需用户确认） | `repo`, `--yes` |
| `issue-create` | 创建 Issue | `--repo`, `--title`, `--body`, `--label`, `--assignee` |
| `issue-view` | 查看 Issue | `--repo`, `number` |
| `issue-close` | 关闭 Issue | `--repo`, `number` |
| `issue-comment` | 评论 Issue | `--repo`, `number`, `--body` |
| `pr-create` | 创建 PR | `--repo`, `--title`, `--body`, `--head`, `--base`, `--draft` |
| `release-create` | 创建 Release | `--repo`, `tag`, `--title`, `--notes`, `--draft`, `--prerelease`, `files` |
| `webhook-list` | 列出 Webhook | `--repo` |
| `webhook-create` | 创建 Webhook | `--repo`, `--url`, `--events`, `--secret` |
| `api` | 通用 API 调用 | `endpoint`, `--method`, `--fields`, `--paginate` |

**快速示例：**

```bash
# 创建私有仓库，带 README
python3 $HELPER repo-create my-project --private --description "项目描述" --readme

# Fork 仓库
python3 $HELPER repo-fork vercel/next.js

# 创建 Issue
python3 $HELPER issue-create --repo owner/repo --title "Bug: xxx" --body "描述" --label bug

# 创建 PR
python3 $HELPER pr-create --repo owner/repo --title "feat: xxx" --body "PR 描述" --head feature-branch --base main

# 发布 Release
python3 $HELPER release-create --repo owner/repo v1.0.0 --title "v1.0.0" --notes "发布说明"

# 创建 Webhook
python3 $HELPER webhook-create --repo owner/repo --url https://example.com/hook --events push --events pull_request

# 通用 API（修改仓库描述）
python3 $HELPER api repos/owner/repo --method PATCH --fields "description=新描述"
```

📖 详细参数和示例见 `references/gh-cli-reference.md`

## 访问策略与回退

| 优先级 | 方式 | 适用场景 |
|--------|------|----------|
| 1 | Python 脚本 + REST API | 所有检索操作 |
| 2 | gh_helper.py + gh CLI | 所有管理操作 |
| 3 | curl 解析静态页面 | API 不可用时的检索回退 |
| 4 | web-access 技能 | 需要浏览器截图或登录态 |

**回退规则：**

| 失败原因 | 回退动作 |
|---------|---------|
| 401/403（代码搜索） | 代码搜索必须认证，提示用户配置 `GITHUB_TOKEN` |
| 401/403（其他检索） | 提示配置 Token，尝试无认证重试 |
| 429 限流（60 次/小时） | 提示配置 Token 提升至 5000 次/小时 |
| API 网络错误 | 回退到 curl 解析 `github.com` 静态页面 |
| 需要浏览器交互/截图 | 委托给 web-access 技能 |

## 输出质量要求

- 数据源必须是 GitHub（`api.github.com` 或 `github.com`），不用第三方聚合或搜索引擎摘要
- 每个结果必须包含可验证的原始 GitHub URL
- 元数据完整 — 仓库有 stars/forks/language/description；Issue 有状态/创建时间/作者；Release 有版本号/日期
- 时效准确 — Trending 和最近 Issue 必须使用正确的时间过滤
- 不编造搜索结果，不美化失真数据
- 不改写用户提供的关键词（空格、大小写、语言名称等）
- 不只返回"查到了/没查到"，必须提供结果内容

## 错误处理

脚本统一使用以下退出码：
- `0`：成功，有结果或明确告知无结果
- `1`：用户输入错误（参数错误、空关键词等）
- `2`：API 错误（限流、拒绝访问、网络错误等）

## 错误做法

- 从非 GitHub 相关的问题自动触发本技能
- 改写用户提供的关键词
- 在 API 失败时编造 GitHub 搜索结果
- 把脚本原始结果改成看似漂亮但信息失真的格式
- 只返回"查到了/没查到"而不提供结果内容
- 把第三方聚合作为 GitHub 数据源
- 在回复中明文展示用户的 Token
