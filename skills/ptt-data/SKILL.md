---
name: ptt-data
description: 查询台湾 PTT 批踢踢实业坊的看板、文章、推文和搜索数据。用于用户提到 PTT、批踢踢、台湾 BBS、特定看板内容、文章搜索，或需要获取 PTT 结构化数据时。
allowed-tools: Bash
---

# PTT 数据接口

通过爬取 PTT 官网 HTML 页面提供结构化 JSON 数据。仅限读取，不涉及登录或发帖。

## 前置条件

仅依赖 Python 3 标准库，无需安装额外包。

## 脚本路径

所有命令基于：

```bash
SCRIPT="/app/runtime/skills-user/ptt-data/scripts/ptt.py"
```

## 命令

### 1. 热门看板列表

返回所有热门看板的名称、在线人数、分类、简介。

```bash
python3 "$SCRIPT" hotboards
python3 "$SCRIPT" hotboards --limit 10
```

### 2. 看板文章列表

获取指定看板的文章列表，每页约 20 篇。省略 `--page` 则返回最新页。

```bash
# 最新一页
python3 "$SCRIPT" board-list Gossiping

# 指定页码（从 1 开始，最新页码约 39000+）
python3 "$SCRIPT" board-list Gossiping --page 39240

# 其他看板同理
python3 "$SCRIPT" board-list Stock
python3 "$SCRIPT" board-list Baseball
```

输出中 `pages.oldest` 和 `pages.newest` 表示可用的分页范围。

### 3. 搜索文章

PTT 内置搜索功能，支持以下语法：

| 语法 | 示例 | 说明 |
|------|------|------|
| 关键词 | `捷運` | 全文搜索 |
| `author:xxx` | `author:breadmin` | 按作者 |
| `recommend:N` | `recommend:100` | 按推荐数筛选（最实用） |

```bash
# 关键词搜索
python3 "$SCRIPT" search Gossiping "捷運"

# 关键词搜索 + 翻页（每页约 20 篇）
python3 "$SCRIPT" search Gossiping "捷運" --page 2

# 按作者
python3 "$SCRIPT" search Gossiping "author:breadmin"

# 按推荐数（高赞文章）
python3 "$SCRIPT" search Gossiping "recommend:100" --limit 5
```

### 4. 文章详情

获取单篇文章的完整内容、元信息和所有推文。

```bash
# 用完整 URL
python3 "$SCRIPT" article "https://www.ptt.cc/bbs/Gossiping/M.1778336352.A.E2F.html"

# 用相对路径
python3 "$SCRIPT" article "/bbs/Gossiping/M.1778336352.A.E2F.html"
```

输出包含：
- `meta`: 作者、看板、标题、时间
- `content`: 文章正文
- `pushes`: 所有推文（类型 push/hiss/arrow、用户、内容、IP 时间）
- `stats`: 推/嘘/→ 统计

### 5. 全站最新文章

跨看板的最新文章聚合。

```bash
python3 "$SCRIPT" allposts
python3 "$SCRIPT" allposts --page 2
```

### 6. 分类看板

PTT 看板的一级分类目录。

```bash
python3 "$SCRIPT" categories
```

## 注意事项

- 所有请求自动携带 `over18=1` Cookie，可访问限制级看板。
- 请求间隔应 >= 3 秒，避免被 PTT 封禁 IP。
- 推文数（nrec）在列表页可能为空，需要查看文章详情才能获取准确推文数据。
- 输出均为 JSON 格式，可直接用 `jq` 等工具处理。
- `title:` 搜索语法不可靠（经常返回空），建议用关键词搜索代替。
