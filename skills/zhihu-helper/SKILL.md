---
name: zhihu-helper
description: 获取知乎热榜、知乎热搜、问题回答、用户信息、收藏夹等数据，并支持发表回答。当用户提到知乎、热榜、热搜、知乎热搜、知乎热点、知乎搜索热词、知乎回答、知乎问题、知乎数据、知乎话题、知乎收藏、收藏夹、知乎发帖、知乎发表、知乎回答问题时，必须使用此技能。此技能依赖 web-access 浏览器 sidecar，提供知乎数据获取与回答发布的成熟快捷方案。
---

# 知乎数据获取助手

提供知乎热榜、问题回答等数据的快速获取方案。依赖 web-access 浏览器 sidecar 的登录态。

## 前置条件

1. web-access 浏览器 sidecar 已启动
2. 知乎登录态已持久化在 `.data/chrome-sidecar`

**检查浏览器代理**：
```bash
curl -s http://127.0.0.1:3456/health
# 预期：{"status": "ok", "port": 3456}
```

---

## CLI 工具（推荐）

固定步骤已封装为 CLI，一行命令即可执行：

| 工具 | 用法 | 说明 |
|------|------|------|
| **fetch_hotlist** | `python3 fetch_hotlist.py [条数] [--api\|--dom]` | 获取知乎热榜（热门问题） |
| **fetch_hot_search** | `python3 fetch_hot_search.py [条数]` | 获取知乎热搜（搜索热词） |
| **fetch_answers** | `python3 fetch_answers.py <问题ID> [条数] [排序]` | 获取问题回答 |
| **fetch_collections** | `python3 fetch_collections.py [条数]` | 获取用户收藏夹 |
| **fetch_invites** | `python3 fetch_invites.py [条数]` | 获取邀请回答列表 |
| **publish-answer** | `python3 publish-answer.py --question-id <ID> --file <文件>` | 发表回答 |

**自动启动**：CLI 会自动检查并启动 cdp-proxy，无需手动干预。

示例：
```bash
# 获取热榜 Top 10（默认 DOM 提取）
python3 ./scripts/fetch_hotlist.py 10

# API 方式（推荐，更快更稳定）
python3 ./scripts/fetch_hotlist.py 10 --api

# 获取问题 2031783702569726072 的前 5 个高赞回答
python3 ./scripts/fetch_answers.py 2031783702569726072 5 votes

# 获取知乎热搜 Top 10
python3 ./scripts/fetch_hot_search.py 10

# 获取用户收藏夹
python3 ./scripts/fetch_collections.py
```

---

## 核心场景

### 1. 获取热榜列表

**两种方式**：

| 方式 | 命令 | 原理 | 速度 |
|------|------|------|------|
| **API**（推荐） | `--api` | 浏览器内 fetch 调 `/api/v3/feed/topstory/hot-lists/total` | ~3s |
| DOM（传统） | 默认 / `--dom` | 打开 `/hot` 页面，CSS 选择器提取 DOM | ~1-6s |

**推荐方法（CLI）**：

```bash
# API 方式（推荐，更快更稳定）
python3 ./scripts/fetch_hotlist.py 10 --api

# DOM 方式（兼容保留）
python3 ./scripts/fetch_hotlist.py 10
python3 ./scripts/fetch_hotlist.py 10 --dom
```

**API 端点**：`https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50&desktop=true`
- 返回 `hot_list_feed` 类型条目
- `card_id` = `Q_{questionId}`，可直接提取问题 ID
- `detail_text` = 热度值（如 "3326 万热度"）
- 需在浏览器页面内 fetch，自动携带登录态

**底层方法（curl + eval）**：打开热榜页面 + DOM 解析

```bash
AGENT_SCOPE="zhihu-hotlist"
TARGET_ID=$(curl -s "http://127.0.0.1:3456/new?url=https://www.zhihu.com/hot&metaAgentScope=${AGENT_SCOPE}" | jq -r '.targetId')
sleep 3

curl -s -X POST "http://127.0.0.1:3456/eval?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}"   --data-binary @./scripts/extract-hotlist.js | jq .

curl -s -X DELETE "http://127.0.0.1:3456/close?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}"
```

**返回字段**：
- `rank` - 排名
- `title` - 问题标题
- `excerpt` - 摘要（前100字）
- `metrics` - 度值
- `url` - 问题链接
- `questionId` - 问题 ID（用于后续获取回答）

---

### 1.5 获取热搜列表

> **热榜 vs 热搜**：热榜 = 热门问题（有 questionId，可直接获取回答）；热搜 = 搜索热词（无直接链接，需搜索后再找相关内容）

**CLI（推荐）**：

```bash
# 获取全部热搜（默认 30 条）
python3 ./scripts/fetch_hot_search.py

# 获取 Top 10
python3 ./scripts/fetch_hot_search.py 10
```

**API 端点**：`https://www.zhihu.com/api/v4/search/hot_search`
- 返回 30 条热搜词
- `query` = 热搜词文本
- `hotShow` = 格式化热度（如 "377 万"）
- `label` = `hot` / `new` / 空（热门/新上标签）
- 需在浏览器页面内 fetch，自动携带登录态

**返回字段**：
- `rank` - 排名
- `query` - 热搜词
- `hotShow` - 热度显示值
- `hot` - 原始热度数值
- `label` - 标签（hot=热门, new=新上, 空=无标签）

---

### 2. 获取问题回答列表

打开问题页面 + 浏览器内 API：

```bash
AGENT_SCOPE="zhihu-answers"
QUESTION_ID="<从热榜获取的questionId>"
TARGET_ID=$(curl -s "http://127.0.0.1:3456/new?url=https://www.zhihu.com/question/${QUESTION_ID}&metaAgentScope=${AGENT_SCOPE}" | jq -r '.targetId')
sleep 3

curl -s -X POST "http://127.0.0.1:3456/eval?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}" \
  --data-binary "$(cat ./scripts/extract-answers.js | sed "s/QUESTION_ID_PLACEHOLDER/${QUESTION_ID}/g")" | jq .

curl -s -X DELETE "http://127.0.0.1:3456/close?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}"
```

**API 参数**：
- `limit` - 每页数量（最大 20）
- `offset` - 偏移量（分页用）
- `sort_by=votes` - 按赞同排序
- `sort_by=created` - 按时间排序
- `sort_by=default` - 默认排序

**include 参数**：
```
data[*].content        # 回答内容（HTML）
data[*].voteup_count   # 赞同数
data[*].comment_count  # 评论数
data[*].created_time   # 创建时间
data[*].author.name    # 作者名
```

---

### 3. 获取单个回答详情

```bash
AGENT_SCOPE="zhihu-answer"
ANSWER_ID="<回答ID>"
TARGET_ID=$(curl -s "http://127.0.0.1:3456/new?url=https://www.zhihu.com&metaAgentScope=${AGENT_SCOPE}" | jq -r '.targetId')
sleep 2

curl -s -X POST "http://127.0.0.1:3456/eval?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}" \
  --data-binary "$(cat ./scripts/get-answer.js | sed "s/ANSWER_ID_PLACEHOLDER/${ANSWER_ID}/g")" | jq .

curl -s -X DELETE "http://127.0.0.1:3456/close?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}"
```

---

### 4. 获取用户收藏夹列表

获取当前登录用户的所有收藏夹：

```bash
AGENT_SCOPE="zhihu-collections"
TARGET_ID=$(curl -s "http://127.0.0.1:3456/new?url=https://www.zhihu.com&metaAgentScope=${AGENT_SCOPE}" | jq -r '.targetId')
sleep 2

# 先获取用户信息得到 url_token
USER_INFO=$(curl -s -X POST "http://127.0.0.1:3456/eval?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}" \  --data-binary '(async()=>{const resp=await fetch("https://www.zhihu.com/api/v4/me",{credentials:"include"});return JSON.stringify(await resp.json());})()')

URL_TOKEN=$(echo "$USER_INFO" | jq -r '.url_token')
FAVORITE_COUNT=$(echo "$USER_INFO" | jq -r '.favorite_count')

# 获取收藏夹列表
curl -s -X POST "http://127.0.0.1:3456/eval?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}" \  --data-binary "(async()=>{const resp=await fetch('https://www.zhihu.com/api/v4/people/${URL_TOKEN}/collections?limit=20&offset=0',{credentials:'include'});return JSON.stringify(await resp.json());})()" | jq '.data[] | {id, title, item_count, is_public}'

curl -s -X DELETE "http://127.0.0.1:3456/close?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}"
```

**返回字段**：
- `id` - 收藏夹 ID
- `title` - 收藏夹名称
- `item_count` - 收藏内容数量
- `is_public` - 是否公开
- `is_default` - 是否为默认收藏夹

---

### 5. 获取收藏夹内容

获取指定收藏夹内的所有收藏内容（支持分页）：

```bash
AGENT_SCOPE="zhihu-collection-content"
COLLECTION_ID="<收藏夹ID>"
TARGET_ID=$(curl -s "http://127.0.0.1:3456/new?url=https://www.zhihu.com&metaAgentScope=${AGENT_SCOPE}" | jq -r '.targetId')
sleep 2

# 分批获取（每页最多20条，offset 从 0 开始）
for offset in 0 20 40 60 80 100; do
  curl -s -X POST "http://127.0.0.1:3456/eval?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}" \  --data-binary "(async()=>{const resp=await fetch('https://www.zhihu.com/api/v4/collections/${COLLECTION_ID}/contents?limit=20&offset=${offset}',{credentials:'include'});return JSON.stringify(await resp.json());})()" > /tmp/coll_${offset}.json
  sleep 1
done

curl -s -X DELETE "http://127.0.0.1:3456/close?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}"
```

**内容类型**：
- `answer` - 回答：包含 `question.title`、`excerpt`、`voteup_count`、`author.name`、`url`
- `article` - 文章：包含 `title`、`excerpt`、`voteup_count`、`author.name`、`url`
- `pin` - 想法：包含 `excerpt_title`、`content[].content`、`author.name`、`url`

**关键字段**：
- `collect_time` - 收藏时间（Unix timestamp）
- `excerpt` - 内容摘要
- `url` - 原文链接

---

### 6. 获取问题元信息

```bash
AGENT_SCOPE="zhihu-question"
QUESTION_ID="<问题ID>"
TARGET_ID=$(curl -s "http://127.0.0.1:3456/new?url=https://www.zhihu.com/question/${QUESTION_ID}&metaAgentScope=${AGENT_SCOPE}" | jq -r '.targetId')
sleep 3

curl -s -X POST "http://127.0.0.1:3456/eval?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}" \
  --data-binary @./scripts/extract-question-meta.js | jq .

curl -s -X DELETE "http://127.0.0.1:3456/close?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}"
```

---

### 7. 获取邀请回答列表

从创作者中心的「邀请回答」页面提取别人邀请你回答的问题列表。

**推荐方法（CLI）**：

```bash
# 获取全部邀请
python3 ./scripts/fetch_invites.py

# 获取前 5 条
python3 ./scripts/fetch_invites.py 5
```

**返回字段**：
- `questionId` - 问题 ID（可用于后续获取回答或发表回答）
- `questionUrl` - 问题链接
- `questionTitle` - 问题标题
- `type` - 类型：`invited_me`（别人邀请）或 `question_expects`（推荐）
- `fullText` - 完整文本（含邀请人、回答数、关注数、时间）

**底层方法（curl + eval）**：

```bash
AGENT_SCOPE="zhihu-invites"
TARGET_ID=$(curl -s "http://127.0.0.1:3456/new?url=https://www.zhihu.com/creator/featured-question/invited&metaAgentScope=${AGENT_SCOPE}" | jq -r '.targetId')
sleep 3

curl -s -X POST "http://127.0.0.1:3456/eval?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}" \
  --data-binary @./scripts/extract-invites.js | jq .

curl -s -X DELETE "http://127.0.0.1:3456/close?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}"
```

**注意事项**：
1. 数据从页面 DOM 提取（SSR 渲染），不是 API 调用
2. 两种类型：`invited_me` = 别人邀请你回答，`question_expects` = 提问期待你解答
3. 页面一次性渲染所有邀请，暂未发现分页

**重试机制**（2026-05-01 新增）：
- 脚本内置自动重试：如果页面返回 0 条邀请，等待 3 秒后自动重新抓取一次
- 避免 SSR 临时性加载失败导致误判为「无邀请」

**跨轮次待回答持久化**：
- 后台周期任务通过 `/app/.data/agent/background/zhihu-invite-pending.json` 持久化未回答的邀请
- 每次执行时先加载历史待回答列表，与实时抓取结果合并去重
- 回答后未处理的剩余邀请自动保存回 pending 文件，下一轮继续

---

## 综合示例：热榜 + 高赞回答

```bash
# 1. 获取热榜 Top 5
TARGET_ID=$(curl -s "http://127.0.0.1:3456/new?url=https://www.zhihu.com/hot&metaAgentScope=zhihu-analysis" | jq -r '.targetId')
sleep 3

HOTLIST=$(curl -s -X POST "http://127.0.0.1:3456/eval?target=${TARGET_ID}&metaAgentScope=zhihu-analysis" \
  --data-binary 'const items=document.querySelectorAll(".HotList-list .HotItem");JSON.stringify(Array.from(items).slice(0,5).map((item,i)=>({rank:i+1,title:item.querySelector(".HotItem-title")?.textContent?.trim(),questionId:(item.querySelector("a")?.href?.match(/question\/(\d+)/)||[])[1]})))' | jq -r '.')

# 2. 复用同一页面获取每个问题的前 3 高赞回答
for QID in $(echo "$HOTLIST" | jq -r '.[].questionId'); do
  curl -s -X POST "http://127.0.0.1:3456/eval?target=${TARGET_ID}&metaAgentScope=zhihu-analysis" \
    --data-binary "(async()=>{const resp=await fetch(`https://www.zhihu.com/api/v4/questions/${QID}/answers?limit=3&sort_by=votes&include=data[*].author.name,voteup_count`,{credentials:\"include\"});return JSON.stringify(await resp.json());})()"
done

curl -s -X DELETE "http://127.0.0.1:3456/close?target=${TARGET_ID}&metaAgentScope=zhihu-analysis"
```

---

## 性能优化

| 优化点 | 建议 |
|--------|------|
| 页面等待 | 热榜/问题页 3秒足够 |
| 页面复用 | 多个问题可复用同一页面调用 API |
| 及时关闭 | 获取完数据立即关闭页面 |

---

## 注意事项

1. **热榜 vs 热搜**：
   - 热榜 = 热门问题（有问题链接，可直接获取回答）
   - 热搜 = 搜索热词（无直接链接，需搜索）
   - 本技能专注热榜

2. **登录态**：知乎登录态在 sidecar 持久化，无需每次登录

3. **反爬虫**：浏览器内 API 调用自动绕过反爬虫机制

4. **数据格式**：回答内容为 HTML，需 `.replace(/<[^>]+>/g, "")` 去除标签

---

## 知乎 API 参考

### 可用 API

| API / 页面 | 用途 | 调用方式 |
|------------|------|----------|
| `/api/v4/questions/{id}/answers` | 问题回答 | 浏览器内 fetch |
| `/api/v4/answers/{id}` | 单个回答 | 浏览器内 fetch |
| `/api/v4/me` | 用户信息 | 浏览器内 fetch |
| `/api/v4/people/{url_token}/collections` | 用户收藏夹列表 | 浏览器内 fetch |
| `/api/v4/collections/{id}/contents` | 收藏夹内容 | 浏览器内 fetch |
| `/creator/featured-question/invited` ⭐ | 邀请回答列表 | DOM 提取（SSR 页面） |

### 分页参数

```
limit=20    # 每页数量（最大 20）
offset=0    # 偏移量（0, 20, 40...）
sort_by=votes     # 按赞同排序
sort_by=created   # 按时间排序
```

---

## 错误处理

```bash
# 检查 API 返回
curl -s -X POST "http://127.0.0.1:3456/eval?..." -d '...' | jq -e '.error' && echo "调用失败"

# 检查页面加载
curl -s "http://127.0.0.1:3456/info?target=${TARGET_ID}" | jq -r '.title'
```

---

## 经验更新与错误修正

### 验证原则

| 类型 | 处理方式 |
|------|----------|
| 实测成功且数据对得上 | 直接写入，标注「实测验证」 |
| 推测/未验证的方法 | 先告诉用户「推测的，请确认」 |
| 用户反馈错误 | **立即修正，记录错误原因** |

### 错误修正记录

当用户反馈 skill 内容有误时，必须：
1. 立即修正 skill 文档
2. 在下方表格记录修正历史

| 日期 | 错误内容 | 修正内容 | 反馈来源 |
|------|----------|----------|----------|
| 2026-04-29 | execCommand 无法触发 Draft.js 状态同步 | 改用 CDP `/type` 端点，使用 Input.insertText 命令 | 实测验证：字数从 0 变正常，发布按钮 enabled |
| （待填写） | （描述错误） | （描述修正） | （用户反馈） |

### 新增能力记录

| 日期 | 新增场景 | 验证状态 | 备注 |
|------|----------|----------|------|
| 2026-04-27 | 获取收藏夹列表 | ✅ 实测验证 | 101条数据成功获取 |
| 2026-04-27 | 获取收藏夹内容（分页） | ✅ 实测验证 | offset 分页正常 |
| 2026-04-29 | 改用 CDP `/type` 端点 | ✅ 实测验证 | 解决 Draft.js 状态同步，回答发布成功（ID: 2032752782281798297） |
| 2026-04-29 | 回答写作风格指南 | ✅ 用户确认 | 人设动态适配、拒绝Markdown、口语化表达、避免AI标志性用语 |

---

## 7. 回答写作风格指南（简要）

知乎回答要像真人写的，不是 AI 生成的结构化文档。

### 7.1 核心规则摘要

| 规则 | 说明 |
|------|------|
| 拒绝 Markdown | 不用标题、代码块、表格 |
| 口语化表达 | 像聊天发帖，不像写文档 |
| 风格随机化 | 8种风格随机切换，不绑定场景 |
| 长度随机化 | 有时候长篇详细，有时候一两句精辟 |
| 有态度情绪 | 可以吐槽、可以站队，不中立陈述 |
| 不伪造身份 | 人设只影响风格，不说"从业XX年" |
| **禁止自曝AI** | 绝对不说"作为AI"、"我是AI"，用人类视角回答 |

**长度随机化**（像真人一样）：
- 一句话神评：20-50 字，精辟、反转、梗
- 简短吐槽：50-100 字，点到即止
- 正常回答：100-300 字，有观点有说明
- 详细回答：300-600 字，展开分析（感兴趣的话题）
- **不要每次都长篇大论，随机选长度！**

**禁止自曝AI身份**（最重要）：
- ❌ 不说：`作为AI...`、`我是AI...`、`作为语言模型...`
- ❌ 不说：`我无法...`、`我没有...`、`我没有感情...`
- ❌ 不说：`从AI的角度看...`、`AI的局限性是...`
- ❌ 不用：AI视角分析AI相关问题
- ✅ 用：人类视角回答，像普通网友一样发表看法

### 7.2 风格随机池

每次回答从以下风格**完全随机**选择：

- **抖机灵** - 一句话神回复、反转、梗
- **正经解答** - 条理清晰、有理有据
- **吐槽风** - 先吐槽再给观点
- **讲故事** - 个人经历开头
- **插科打诨** - 半正经半玩笑
- **反问式** - 用反问引发思考
- **数据流** - 先抛数据再给观点
- **情绪流** - 有态度站队

### 7.3 高风险话题禁选

| 禁选类型 | 关键词示例 |
|----------|-----------|
| 法律案件 | 判决、诉讼、赔偿、法院、判刑 |
| 企业负面 | 倒闭、破产、裁员、欠薪、投诉 |
| 品牌争议 | vs、翻车、塌房、谁更好、车企高管互怼、品牌对标拉踩 |
| 个人隐私 | 人品、私生活、出轨 |

#### 已确认禁答话题（遇到即跳过，不要发表回答）

- **李想 vs 大众** — `李想称「理想领先大众至少两代」，大众高管回应理想「仅价格和营销水平领先」`
  - 归类：品牌争议 / 车企高管互怼 / 品牌对标拉踩
  - 原因：双方互怼话题，无安全立场，易引发争议

### 7.4 回答自查清单

发表前检查：
- [ ] 没有对企业做绝对化负面定性
- [ ] 没有无数据支撑的对比拉踩
- [ ] 没有揣测企业动机
- [ ] 涉及企业内容加了"个人观察"限定
- [ ] 风格不是固定的，有随机变化

---

> **详细指导**：
> - 风格多样化、人设设定、写作技巧 → 见 `writing-style-guide.md`
> - 企业风险规避、选题风险规避 → 见 `risk-avoidance.md`

## 8. 发表回答

推荐使用 Python 脚本 `publish-answer.py` v3 版本，已集成反AI检测增强（每日上限、浏览调研、逐段模拟打字）。

### 新命令一览

```bash
# 【推荐流程】先浏览调研，再发布
# 第1步：浏览问题详情和已有回答（输出风格分析到 stderr）
python3 ./scripts/publish-answer.py --question-id <ID> --browse

# 第2步：根据调研结果生成回答后发布
python3 ./scripts/publish-answer.py --question-id <ID> --file ./answer.md

# 直接发布（内容方式）
python3 ./scripts/publish-answer.py --question-id <ID> --content "回答内容"

# 检查是否已回答
python3 ./scripts/publish-answer.py --question-id <ID> --check

# 列出已回答记录
python3 ./scripts/publish-answer.py --list

# 强制回答（跳过已答检查和每日上限）
python3 ./scripts/publish-answer.py --question-id <ID> --file <文件> --force

# 跳过每日上限（但不跳过已答检查）
python3 ./scripts/publish-answer.py --question-id <ID> --file <文件> --skip-daily-limit

# 设置自定义每日上限
python3 ./scripts/publish-answer.py --question-id <ID> --file <文件> --daily-limit 15
```

### 新参数

| 参数 | 说明 |
|------|------|
| `--browse` | 仅浏览调研不发布，输出问题详情 + 已有回答风格分析到 stderr |
| `--force` | 强制发布（跳过已答检查和每日上限） |
| `--skip-daily-limit` | 跳过每日上限检查（但不跳过已答检查） |
| `--daily-limit N` | 设置当日上限条数（默认 10，可设置环境变量 `ZHIHU_DAILY_LIMIT`） |
| `--persona` | 回答人设（留空时从人设池随机选择，避免全员"专家"） |

### 关键说明

- **v3（2026-05-02）**：每日硬上限（默认 10 条/天）、发布前自动浏览已有回答并输出分析到 stderr、逐段模拟真人打字、固定等待改为随机延迟
- **必须使用** `POST http://127.0.0.1:3456/type?...` 而非 `execCommand('insertText')`
- `/type` 调用 CDP `Input.insertText`，解决 Draft.js / React 编辑器状态同步问题
- `--browse` 是推荐前置步骤：先看已有回答的风格分布，再做差异化回答
- `--check` 需要配合 `--question-id` 使用，查询 `answered-questions.json` 防重复回答
- 推荐将回答存为 `./answer.md`，用 `--file` 参数避免 shell 转义问题
- 自动记录 `questionId / answerId / answerUrl / answeredAt / persona` 到 `answered-questions.json`
- **Scope 优先级**：`--scope` 参数 > 环境变量 `CLAUDE_AGENT_ID` > 默认值 `zhihu-publish`

**重要**：conn worker 任务在 `BackgroundAgentRunner.run()` 中已通过 `runWithScopedAgentEnvironment(runId)` 设置 scope 环境变量，并在任务结束时通过 `closeBrowserTargetsForScope(runId)` 清理浏览器页面。脚本无需显式传递 `--scope`，会自动从环境变量继承。

如 `/type` 端点不可用，请检查 web-access 代理和 sidecar CDP：

```bash
curl -s http://127.0.0.1:3456/health
node /app/runtime/skills-user/web-access/scripts/check-deps.mjs
```

---

## 9. 反AI检测策略

> 核心原则：从**行为节奏**和**内容调性**两个层面伪装成真人，让知乎的反作弊系统无法通过行为指纹识别自动化。

### 9.1 每日回答上限（硬限制）

| 项目 | 值 |
|------|-----|
| 默认上限 | 10 条/天 |
| 推荐上限 | 5~8 条/天（选高质量而非数量） |
| 超限行为 | 脚本自动拒绝，返回 `daily_limit_reached` |
| 环境变量 | `ZHIHU_DAILY_LIMIT=8` 动态调整 |

**为什么要硬限制？**
- 4天117条 = 行为模式必然被知乎反作弊识别
- 真人正常的回答密度是 1~5 条/周，不是 30 条/天
- 硬上限阻止脚本高频触发，从源头消除行为指纹

### 9.2 浏览调研机制

脚本发布前自动执行：

```
打开问题页面
  ├─ 读取问题描述和标签
  ├─ 获取前 N 条已有回答（浏览器内 API）
  ├─ 分析已有回答的长度分布（短/中/长）
  ├─ 输出风格差异化建议到 stderr
  └─ 随机阅读时间 3~10 秒（伪装真人阅读）
→ 进入发布流程
```

**收益**：
- 阅读时间不是干等，而是真的在看内容
- 风格建议让 agent 写出差异化的回答，避免同质化
- 浏览行为增加了账号活动多样性（不再是单纯打开→发布→关闭）

### 9.3 行为随机化

脚本中所有固定等待都已替换为随机延迟：

| 原版（固定的） | v3 版（随机的） |
|----------------|-----------------|
| `time.sleep(5)` | `random.uniform(3, 7)` |
| `time.sleep(3)` | `random.uniform(2, 5)` |
| `time.sleep(1)` | `random.uniform(0.5, 2.0)` |
| 一次输完所有内容 | 逐段输入，段间随机 2~5 秒 |

### 9.4 逐段模拟打字

回答内容按段落分割，每段通过 CDP `/type` 逐个输入，段间随机等待 2~5 秒：

```
第1段 → 输入完成 → 等待 3.2s → 第2段 → ...
```

- 短内容（< 80 字）一次输入
- 长内容逐段输入，模拟真人打字节奏
- 避免了"瞬间写出 500 字"的 AI 行为特征

### 9.5 Persona 人设随机化

不再全员使用"专家"人设。脚本内置人设池（10 种），每次发布自动随机选择：

```
互联网行业观察者 / AI产品用户 / 科技爱好者
行业从业者 / 产品设计师 / 职场过来人
生活探索者 / 数码爱好者 / 故事分享者 / 知识科普爱好者
```

也可以使用 `--persona "自定义人设"` 强制指定。

### 9.6 `--browse` 模式（AI agent 推荐工作流）

这是推荐的回答前调研步骤——先看已有回答再动笔：

```bash
# 1. 先浏览，获取问题详情和已有回答分析
python3 publish-answer.py --question-id <ID> --browse

# stderr 输出示例：
# ═══════════════════════════════════════
#   问题调研报告
# ═══════════════════════════════════════
#   标题: xxx
#   标签: 科技, AI
#   已有回答: 8条
#     短回答（≤100字）: 5条
#     中等（100~300字）: 2条
#     长文（>300字）: 1条
#   💡 建议: 已有回答以短评为主，建议写中等长度回答
#   热门回答: [128赞] 张三: 说实话...
# ═══════════════════════════════════════

# 2. 根据调研结果生成回答，然后发布
python3 publish-answer.py --question-id <ID> --file answer.md
```

### 9.7 总结对照表

| 反检测维度 | 实现方式 | 效果 |
|-----------|----------|------|
| 回答频率 | 每日硬上限（默认 10 条） | 从源头遏制高频行为 |
| 浏览伪装 | 自动阅读已有回答 + 随机阅读时间 | 行为不再是"打开→发布→关闭" |
| 打字节奏 | 逐段输入 + 随机段间延迟 | 消除瞬间输出特征 |
| 等待时间 | 全部固定 sleep 改为随机延迟 | 消除精确时间窗口 |
| 内容调性 | 浏览输出风格建议 + 差异化选型 | 避免同质化内容 |
| 人设多样性 | 内置人设池随机选择 | 消除全员"专家"指纹 |
| 环境变量 | `ZHIHU_DAILY_LIMIT` 动态调整 | 灵活应对不同账号 |

> **重要**：以上机制是脚本层面的自动保护。回答的**实际文本质量**仍然取决于 agent 在 prompt 中的写作指导——务必遵守第 7 节的写作风格指南。
