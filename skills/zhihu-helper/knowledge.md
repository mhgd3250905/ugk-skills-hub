# 知乎知识库

> 记录知乎数据获取相关的所有知识，包括 API、技巧、注意事项等
> 每次发现新知识时追加到本文件

---

## 已验证的知识

### API 端点

| API | 用途 | 状态 | 发现时间 |
|-----|------|------|----------|
| `/api/v4/questions/{id}/answers` | 问题回答列表 | ✅ 可用 | 2026-04-27 |
| `/api/v4/answers/{id}` | 单个回答详情 | ✅ 可用 | 2026-04-27 |
| `/api/v4/me` | 用户信息 | ✅ 可用 | 2026-04-27 |
| `/api/v4/search/hot_search` | 热搜列表 | ✅ 可用（但非热榜） | 2026-04-27 |
| `/api/v3/feed/topstory` | 首页推荐 | ✅ 可用 | 2026-04-27 |
| `/api/v3/feed/topstory/hot-lists/total` ⭐ | 热榜列表（JSON API） | ✅ 可用 | 2026-05-11 |
| `/api/v4/search/hot_search` ⭐ | 热搜词列表（JSON API） | ✅ 可用 | 2026-05-11 |
| `/creator/featured-question/invited` ⭐ | 邀请回答列表（SSR 页面，DOM 提取） | ✅ 可用 | 2026-05-01 |

### DOM 解析模式

| 页面 | 元素选择器 | 用途 |
|------|-----------|------|
| `/hot` | `.HotList-list .HotItem` | 热榜列表 |
| `/hot` | `.HotItem-title` | 问题标题 |
| `/hot` | `.HotItem-excerpt` | 问题摘要 |
| `/hot` | `.HotItem-metrics` | 热度值 |
| `/question/{id}` | `h1.QuestionHeader-title` | 问题标题 |

### 关键发现

1. **热榜 vs 热搜**（2026-04-27）
   - 热榜：热门问题，有问题链接和 ID
   - 热搜：搜索热词，无直接链接
   - 用户通常需要的是热榜

2. **浏览器内 API 调用**（2026-04-27）
   - 直接 curl 调用知乎 API 会失败（反爬虫）
   - 必须在浏览器页面内用 fetch() 调用
   - 自动携带登录态（credentials: "include"）

3. **回答内容格式**（2026-04-27）
   - 回答内容是 HTML 格式
   - 需用 `.replace(/<[^>]+>/g, "")` 去除标签

4. **登录态持久化**（2026-04-27）
   - 登录态在 `.data/chrome-sidecar` 持久化
   - 无需每次重新登录

5. **邀请回答列表**（2026-05-01）
   - 入口：`https://www.zhihu.com/creator/featured-question/invited`
   - 数据通过 DOM 提取（SSR 渲染），无可用 JSON API（尝试 6 种 API 均返回 404）
   - DOM 选择器：`[class*="vurnku"]` 下找 `<a href*="/question/">`
   - 两种类型：`invited_me`（别人邀请）和 `question_expects`（推荐）
   - 封装命令：`python3 fetch_invites.py [条数]`

---

## 新知识待验证

（每次发现新知识时，先在此记录，验证后移到"已验证的知识"）

<!-- 示例格式：
### 待验证项

- [ ] API: `/api/v4/topics/{id}` - 话题信息
  - 发现时间：2026-04-28
  - 发现来源：用户请求
  - 验证命令：...

-->

---

## 知识更新日志

| 时间 | 更新内容 |
|------|----------|
| 2026-05-11 | 新增热搜 CLI `fetch_hot_search.py`，发现热搜 API (`/api/v4/search/hot_search`) |
| 2026-05-11 | 发现热榜 JSON API (`/api/v3/feed/topstory/hot-lists/total`)，`fetch_hotlist.py` 新增 `--api` 模式 |
| 2026-05-01 | 新增邀请回答列表获取能力，添加 `fetch_invites.py` + `extract-invites.js` |
| 2026-05-01 | 新增禁答话题：李想 vs 大众（车企高管互怼/品牌对标拉踩类话题），记录到 SKILL.md 7.3 节 |
| 2026-04-27 | 初始化知识库，记录热榜、回答 API、DOM 解析模式 |

---

## 如何添加新知识

当你发现新的知乎知识时（新 API、新技巧、新问题）：

1. **先记录到"新知识待验证"**
   - 写明 API/技巧名称
   - 写明发现时间、来源
   - 写明验证命令（如果有）

2. **验证后移到"已验证的知识"**
   - 更新状态为 ✅ 可用 或 ❌ 不可用
   - 添加必要的使用说明

3. **更新 SKILL.md**
   - 如果是常用功能，添加到 SKILL.md 的对应章节
   - 如果是复杂脚本，添加到 scripts/ 目录

4. **更新更新日志**
   - 记录本次更新内容

---

*知识库创建时间：2026-04-27*