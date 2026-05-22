# PTT Data Skill

PTT 批踢踢实业坊数据接口，通过爬取 PTT 官网 HTML 页面提供结构化 JSON 数据。

## 功能

- **热门看板列表** - 获取所有热门看板信息
- **看板文章列表** - 获取指定看板的文章列表，支持分页
- **搜索文章** - 支持关键词、作者、推荐数搜索
- **文章详情** - 获取文章完整内容、元信息和推文
- **全站最新文章** - 跨看板最新文章聚合
- **分类看板** - PTT 看板分类目录

## 前置条件

仅依赖 Python 3 标准库，无需安装额外包。

## 使用方法

```bash
# 热门看板
python3 scripts/ptt.py hotboards

# 看板文章列表
python3 scripts/ptt.py board-list Gossiping

# 搜索文章
python3 scripts/ptt.py search Gossiping "捷運"

# 文章详情
python3 scripts/ptt.py article "https://www.ptt.cc/bbs/Gossiping/M.1778336352.A.E2F.html"

# 全站最新文章
python3 scripts/ptt.py allposts

# 分类看板
python3 scripts/ptt.py categories
```

## 注意事项

- 所有请求自动携带 `over18=1` Cookie
- 请求间隔应 >= 3 秒，避免被封禁 IP
- 输出均为 JSON 格式
