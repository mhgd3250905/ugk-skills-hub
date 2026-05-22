# GitHub 检索命令参考

## 脚本路径

```bash
SEARCH=/app/runtime/skills-user/github-helper/scripts/github_search.py
```

## 子命令

### 1. `search-repos` — 仓库搜索

```bash
python3 $SEARCH search-repos \
  --keyword "react table" \
  --lang typescript \
  --min-stars 1000 \
  --sort stars \
  --order desc \
  --limit 10
```

**参数：**
- `--keyword`：搜索关键词（必填）
- `--lang`：编程语言过滤（如 typescript, python, go）
- `--min-stars`：最低 Star 数
- `--max-stars`：最高 Star 数
- `--sort`：排序方式（stars/forks/updated），默认 stars
- `--order`：排序方向（desc/asc），默认 desc
- `--limit`：返回条数，默认 10，最大 50

**示例输出：**
```
GitHub 仓库搜索结果
关键词：react table
语言：typescript
最低 Star：1000
排序：stars desc

共找到 243 个仓库，显示前 10 个

1. TanStack/table ⭐ 26123
   描述：🤖 Headless UI for building powerful tables & datagrids
   语言：TypeScript | 分支数：3874 | Issue数：285
   URL：https://github.com/TanStack/table
```

### 2. `repo-info` — 仓库详细信息

```bash
# 查看仓库基本信息
python3 $SEARCH repo-info vercel/next.js --basic

# 查看 README
python3 $SEARCH repo-info vercel/next.js --readme

# 查看 Releases
python3 $SEARCH repo-info vercel/next.js --releases --limit 5

# 查看 License
python3 $SEARCH repo-info vercel/next.js --license

# 查看 Contributors
python3 $SEARCH repo-info vercel/next.js --contributors --limit 10

# 查看全量信息（默认）
python3 $SEARCH repo-info vercel/next.js --all
```

**参数：**
- `owner/repo`：仓库名（位置参数，必填）
- `--basic`：基本信息（stars/forks/language/description/topics 等）
- `--readme`：README 内容（摘要或全文）
- `--releases`：发布版本列表
- `--license`：许可证信息
- `--contributors`：贡献者列表
- `--all`：全部信息（默认）
- `--limit`：控制 releases 和 contributors 的返回条数

**示例输出：**
```
GitHub 仓库信息
仓库：vercel/next.js
URL：https://github.com/vercel/next.js

基本信息
- Stars：131234 | Forks：28123
- 语言：JavaScript | License：MIT
- 创建时间：2016-10-05 | 最后更新：2025-04-29
- Topics：react, ssr, static-site-generator, web, serverless
- 描述：The React Framework

README 摘要
（README 前 300 字符...）
完整 README：https://github.com/vercel/next.js#readme

最新 Release：v15.3.1（2025-04-15）
```

### 3. `search-issues` — Issues / PRs 搜索

```bash
python3 $SEARCH search-issues \
  --repo vercel/next.js \
  --keyword "hydration error" \
  --state open \
  --type issue \
  --sort created \
  --order desc \
  --limit 10
```

**参数：**
- `--repo`：仓库名，格式 `owner/repo`（可选，不指定则全局搜索）
- `--keyword`：关键词
- `--state`：状态（open/closed/all），默认 all
- `--type`：类型（issue/pr/all），默认 all
- `--label`：标签过滤（可重复）
- `--sort`：排序（created/updated/comments），默认 created
- `--order`：排序方向（desc/asc），默认 desc
- `--limit`：返回条数，默认 10，最大 50

**示例输出：**
```
GitHub Issue 搜索结果
仓库：vercel/next.js
关键词：hydration error
状态：open
排序：created desc

共找到 18 个 open issue，显示前 10 个

1. #75642 | hydration error with server components
   状态：🟢 Open | 类型：🐛 Bug
   作者：user123 | 创建时间：2025-04-28 | 评论数：5
   URL：https://github.com/vercel/next.js/issues/75642
```

### 4. `search-code` — 代码搜索

```bash
python3 $SEARCH search-code \
  --keyword "useEffect cleanup" \
  --lang javascript \
  --limit 10
```

**参数：**
- `--keyword`：代码关键词
- `--lang`：编程语言过滤
- `--owner`：用户/组织过滤
- `--repo`：仓库过滤
- `--path`：文件路径过滤
- `--limit`：返回条数，默认 10，最大 50

> ⚠️ **注意**：GitHub 代码搜索 API **要求认证**（即使搜索公开代码也需要 `GITHUB_TOKEN`）。如未设置 Token，该功能会返回 401 错误。其他搜索功能（仓库、Issues、用户）在无 Token 时也可正常工作，仅限流更严格。

### 5. `trending` — 趋势项目

```bash
# 默认本周所有语言
python3 $SEARCH trending

# Python 语言本周趋势
python3 $SEARCH trending --lang python --since weekly

# JavaScript 本月趋势
python3 $SEARCH trending --lang javascript --since monthly
```

**参数：**
- `--lang`：编程语言
- `--since`：时间范围（daily/weekly/monthly），默认 weekly
- `--limit`：返回条数，默认 15，最大 50

**示例输出：**
```
GitHub Trending - 本周
语言：python

1. langgenius/dify ⭐ 123456
   描述：Dify is an open-source LLM app development platform
   语言：Python | Stars：123456（本周增长 +8900）
   URL：https://github.com/langgenius/dify
```

### 6. `user-info` — 用户/组织信息

```bash
python3 $SEARCH user-info torvalds
python3 $SEARCH user-info vercel --repos --limit 20
```

**参数：**
- `username`：GitHub 用户名或组织名（位置参数）
- `--repos`：同时列出公开仓库
- `--limit`：仓库列表条数，默认 10，最大 50
