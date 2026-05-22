# Reddit Data Skill

Reddit 数据接口，通过 Reddit 公开 JSON API 提供结构化数据。

## 功能

- **搜索帖子** - 全站搜索或限定子版块内搜索
- **子版块帖子列表** - 获取指定子版块的热门、最新等帖子
- **帖子详情与评论** - 获取帖子完整内容和评论树
- **搜索子版块** - 查找与关键词相关的子版块
- **默认推荐子版块** - 获取 Reddit 热门子版块列表

## 前置条件

仅依赖 Python 3 标准库，无需安装额外包。

## 使用方法

```bash
# 搜索帖子
python3 scripts/reddit.py search "machine learning"

# 限定子版块搜索
python3 scripts/reddit.py search "error handling" --subreddit Python

# 子版块帖子列表
python3 scripts/reddit.py subreddit programming

# 帖子详情
python3 scripts/reddit.py post "https://www.reddit.com/r/Python/comments/1abc123/post_title/"

# 搜索子版块
python3 scripts/reddit.py find-subreddit "python"

# 热门子版块
python3 scripts/reddit.py trending
```

## 注意事项

- 使用 Reddit 公开 JSON API，无需认证
- 请求间隔应 >= 2 秒，避免被 rate limit
- `--limit` 参数最大值为 100
- 输出均为 JSON 格式
