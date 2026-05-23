# LinkedIn Search Spider — 设计文档

## 概述

`linkedin_search.mjs` 是 medtrum-pcm 舆情监控技能的 LinkedIn 平台数据采集脚本。

**职责：** 打开 LinkedIn 搜索结果页 → 滚动到底 → 采集所有帖子卡片 → 输出结构化 JSON。

**调用方式：**
```bash
node linkedin_search.mjs --keyword "Medtrum" --days 30
node linkedin_search.mjs --keyword "TouchCare" --days 30 --max-results 50
node linkedin_search.mjs --keyword "test" --days 30 --dry-run
```

## 架构：两阶段分离

```
┌─────────────────────────────────────────────────────────┐
│ Phase 1 (Browser CDP) — 纯采集，零解析                    │
│                                                         │
│  collectRawCards()  只做 DOM 遍历，提取原始文本+链接       │
│  scrollStep()       纯滚动，返回滚动位置信息               │
│                                                         │
│  设计原则：绝不在 CDP 侧做解析/正则/字符串匹配              │
│  容错：每个卡片 try-catch，失败记录日志继续下一个           │
└──────────────────────┬──────────────────────────────────┘
                       │ raw cards [{text, links, authorHref}]
                       ▼
┌─────────────────────────────────────────────────────────┐
│ Phase 2 (Node.js) — 解析 + 去重 + 过滤                    │
│                                                         │
│  processCards()    时间提取、URL 解析、去重、时间过滤       │
│  parseLinkedInTimeLabel()  相对时间 → 绝对时间戳           │
│                                                         │
│  所有正则/字符串匹配仅在 Node 侧进行                       │
└─────────────────────────────────────────────────────────┘
```

### 为什么不把解析放在 CDP 侧？

1. **CDP Runtime.evaluate 对模板字面量有编码问题** — 多行字符串可能挂起
2. **中文正则字面量在 CDP 中不可靠** — 需 `String.fromCharCode()` 绕行
3. **解析失败不应阻断采集** — 坏卡片可跳过，但滚动必须继续

## 底部检测：三层兜底

```
scrollStep() → nearBottom=true + 无新帖
  │
  ├─ (1) Bounce: 上滚 50% 视口 → 等 1.5s → 滚回底部 → 等 2s → 采集
  │     └─ 有新帖 → 继续滚动
  │     └─ stillLoading → 等一轮（LinkedIn 可能正在渲染）
  │
  ├─ (2) 按钮检测: bounce 无效后，位置策略查找底部 button
  │     找 scrollHeight 下方 400px 内最近的可视 button → 点击
  │     └─ 有新帖 → 继续
  │
  └─ (3) Stall 兜底: stillLoading 永久 true 时
        连续 3 轮底部 + 0 新帖 → 强制退出
        处理 LinkedIn 底部的 persistent loading indicator
```

**为什么需要 Stall 兜底？** LinkedIn 在搜索结果底部可能显示永久的 loading spinner（即使没有更多内容），导致 `stillLoading=true` 恒成立，绕过正常退出路径。

## CDP 表达式规范

**所有 CDP evaluate 表达式必须通过 `toExpression()` 包装：**

```javascript
// ✅ 正确：函数 toString() → IIFE，无模板字面量
await evaluate(targetId, toExpression(scrollStep));

// ❌ 错误：模板字面量在 ES module 上下文中可能挂起
await evaluate(targetId, `(() => { ... })()`);

// ❌ 错误：CDP 侧不应有中文正则或字符串匹配
await evaluate(targetId, `document.querySelector('.some-class')`);
```

## 采集卡片的 DOM 策略

### 标准帖
```
card-wrapper
├── header (作者 • N天前 • 关注)     ← 有作者+时间
└── content (帖子正文)               ← 有/feed/update/ 链接
```

`pickContainer()` 从作者链接往上爬，停在 160-3000 字符的容器，再上爬至最外层 wrapper。

### 分享帖（v6 修复）
```
feed-container (50000+ chars)
├── wrapper-A
│   ├── header-author              ← 分享者
│   ├── header-time (2 天 •)       ← 时间，innerText 可见
│   └── commentary                  ← 分享者评论
├── wrapper-B
│   └── shared-card                 ← 被转发的帖子内容
```

**问题：** header / shared-card 常在不同 wrapper 中，`pickContainer` 采到 wrapper-B 或 shared-card 后，单层 `previousElementSibling` 为空。

**v6 方案：** 多层祖先遍历 — 从 `sourceEl` 沿 `parentElement` 链上爬 5 层，每层遍历 `parentElement.children` 收集 sourceEl 前的兄弟元素文本，突破 wrapper 边界获取 header-time。

## URL 提取优先级

采集时从卡片内所有 `<a href>` 中按优先级取帖子 URL：

1. `/feed/update/urn:li:share:...` — 帖子永久链接（最可靠）
2. `/posts/...-activity-...` — 帖子 activity 链接
3. 任意非作者/非搜索的内部链接
4. `/safety/go?url=...` — 解码后若是 LinkedIn 域名则使用
5. 作者主页链接（兜底，非帖子链接）

## 时间解析

在 Node 侧进行，支持中英文格式：

| 格式 | 正则（Node 侧，CDP 安全） |
|------|--------------------------|
| 分钟 | `\d+\s*分钟\|分\|mins?\|minutes?` |
| 小时 | `\d+\s*小时\|hrs?\|hours?` |
| 天 | `\d+\s*天\|days?` |
| 周 | `\d+\s*周\|weeks?\|w` |
| 月 | `\d+\s*个月\|月\|months?\|mos?` |
| 绝对日期 | `Date.parse()` 兜底 |
| ISO 日期 | `\d{4}[-/]\d{1,2}[-/]\d{1,2}` 全文扫描兜底 |

## 输出格式

```json
{
  "platform": "LinkedIn",
  "keyword": "Medtrum",
  "retrievedAt": "2026-05-23T...",
  "queryUrl": "https://www.linkedin.com/search/...",
  "preflight": { "ok": true, "title": "搜索 | LinkedIn" },
  "scrollNote": "Bottom reached (20 rounds, 39 posts)",
  "total": 27,
  "dropped": 12,
  "items": [
    {
      "date": "2 天",
      "authorName": "Phil Ford",
      "authorHandle": "https://www.linkedin.com/in/philipnford/",
      "content": "...",
      "url": "https://www.linkedin.com/feed/update/..."
    }
  ]
}
```

## 命令行参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--keyword` | 必填 | 搜索关键词 |
| `--days` | 30 | 时间范围（天） |
| `--max-scrolls` | 50 | 最大滚动轮数 |
| `--max-results` | 100 | 最大结果数 |
| `--dry-run` | false | 仅输出 URL，不执行采集 |
| `--debug-dump` | - | 将原始采集数据写入指定 JSON 文件 |

## 依赖

- `linkedin_search_lib.mjs` — URL 构建 + 输出格式化
- `../../web-access/scripts/host-bridge.mjs` — 浏览器 sidecar CDP 通信

## 变更记录

| 版本 | 日期 | 主要变更 |
|------|------|----------|
| v6 | 2026-05-23 | 修复分享帖时间标签缺失。`pickContainer` 等长上爬（`pt.length === t.length && t.length < 2000`），突破 wrapper 层。`processCards` 去重逻辑支持缺时间→有时间替换。 |
| v5 | 2026-05-23 | 两阶段架构重构。CDP 侧零解析。底部三层兜底检测。按钮检测改位置策略。兄弟元素扫描。跨轮共享去重 Set。 |
| v4 | 2026-05-23 | 卡片优先架构。`String.fromCharCode()` 替代中文正则。移除脆弱 CSS class 依赖。 |
| v3 | - | 单阶段底部检测。统一 `deadEndCount`。 |
