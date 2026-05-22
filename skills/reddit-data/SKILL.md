---
name: reddit-data
description: 搜索和浏览 Reddit 帖子、评论、子版块。用于用户提到 Reddit、特定 subreddit 内容、帖子搜索、热门话题，或需要获取 Reddit 结构化数据时。
allowed-tools: Bash
---

# Reddit 数据接口

通过 Reddit 公开 JSON API 提供结构化数据。仅限读取，不涉及登录或发帖。

## 双通道架构

由于服务器 IP 可能被 Reddit 反爬机制封禁（403），本技能采用双通道：

1. **HTTP 直连通道**：直接调用 Reddit 公开 JSON API（`.json` 端点），快速但易被封
2. **浏览器降级通道**：遇到 403 自动切换到 Chrome sidecar，通过 `old.reddit.com` DOM 提取数据

浏览器通道通过 `reddit-browser.mjs` 实现，需要 Chrome sidecar 已连接（通过 `web-access` 技能激活）。
如果 sidecar 未连接，会给出明确提示。

## 前置条件

HTTP 通道仅依赖 Python 3 标准库。浏览器通道额外需要 Node.js 和已连接的 Chrome sidecar。

## 脚本路径

所有命令基于：

```bash
SCRIPT="/app/runtime/skills-user/reddit-data/scripts/reddit.py"
```

## 命令

### 1. 搜索帖子

全站搜索或限定在某个子版块内搜索。

```bash
# 全站搜索
python3 "$SCRIPT" search "machine learning"

# 限定子版块
python3 "$SCRIPT" search "error handling" --subreddit Python

# 按最新排序
python3 "$SCRIPT" search "Rust vs Go" --sort new --limit 5

# 按热度搜索过去一周
python3 "$SCRIPT" search "AI agent" --sort top --time week --limit 10
```

排序选项：`relevance`（默认）、`hot`、`new`、`top`、`comments`
时间选项：`hour`、`day`、`week`、`month`、`year`、`all`（默认）

输出包含 `after` / `before` 游标，可用于分页（见 subreddit 命令的 `--after` 参数说明）。

### 2. 子版块帖子列表

获取指定子版块的帖子列表（热门、最新、上升等）。

```bash
# 热门帖子（默认）
python3 "$SCRIPT" subreddit programming

# 最新帖子
python3 "$SCRIPT" subreddit Python --sort new --limit 10

# 历史最佳（过去一个月）
python3 "$SCRIPT" subreddit MachineLearning --sort top --time month --limit 5

# 争议帖
python3 "$SCRIPT" subreddit technology --sort controversial --time week

# 翻页（使用上一页返回的 after 游标）
python3 "$SCRIPT" subreddit Python --sort hot --after t3_abc123
```

排序选项：`hot`（默认）、`new`、`rising`、`top`、`controversial`
时间选项（仅 top/controversial 有效）：`hour`、`day`、`week`（默认）、`month`、`year`、`all`

### 3. 帖子详情与评论

获取帖子的完整内容、元信息和评论树。

```bash
# 用完整 URL
python3 "$SCRIPT" post "https://www.reddit.com/r/Python/comments/1abc123/post_title/"

# 用 permalink
python3 "$SCRIPT" post "/r/Python/comments/1abc123/post_title/"

# 自定义评论数量和排序
python3 "$SCRIPT" post "https://www.reddit.com/r/programming/comments/1abc123/title/" --comments-limit 50 --comments-sort top
```

评论排序选项：`best`（默认）、`top`、`new`、`controversial`、`old`、`qa`

输出包含：
- `post`: 帖子标题、正文、分数、评论数、作者、时间等
- `comments`: 评论列表，每条包含嵌套的 `replies`（回复树）

### 4. 搜索子版块

查找与关键词相关的子版块（subreddit）。

```bash
# 搜索 Python 相关的子版块
python3 "$SCRIPT" find-subreddit "python"

# 搜索游戏相关
python3 "$SCRIPT" find-subreddit "gaming" --limit 5
```

输出包含每个子版块的名称、标题、订阅人数、简介。

### 5. 默认推荐子版块

获取 Reddit 默认推荐的热门子版块列表。

```bash
python3 "$SCRIPT" trending
```

## 使用场景示例

- "Reddit 上怎么评价 xxx？" → 用 `search` 全站搜索
- "r/programming 最近有什么热门帖子？" → 用 `subreddit programming --sort hot`
- "帮我看看这个 Reddit 帖子的评论" → 用 `post` 获取详情
- "有没有关于 xxx 的 subreddit？" → 用 `find-subreddit` 搜索
- "Reddit 上现在流行什么？" → 用 `trending`

## 注意事项

- 使用 Reddit 公开 JSON API，无需认证，但有一定频率限制。
- 请求间隔应 >= 2 秒，避免被 rate limit。
- `--limit` 参数最大值为 100，Reddit API 限制单次最多返回 100 条。
- 翻页使用 `after`/`before` 游标（基于帖子的 `name` 字段，如 `t3_abc123`），而非页码。
- 输出均为 JSON 格式，可直接用 `jq` 等工具处理。
- 帖子正文 `selftext` 使用 Markdown 格式；`selftext_html` 为 HTML 格式（仅 post 命令返回）。
