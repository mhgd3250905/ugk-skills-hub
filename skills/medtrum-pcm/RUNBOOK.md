# Medtrum-PCM 交接文档

> 2026-05-07 · 链式 Step Contract 架构 · v1.0

## 一句话

`/medtrum-pcm` 技能。conn 每天 08:00 触发 → Agent 按 14 步链式合约逐步执行 → 检索 5 平台 Medtrum/TouchCare 舆情 → 判断相关性+情感 → 生成报告 → 发邮件。

## 入口

conn 任务 prompt：`/medtrum-pcm`

SKILL.md 位置：`/app/runtime/skills-user/medtrum-pcm/SKILL.md`

## 文件结构

```
app/
├── runtime/skills-user/medtrum-pcm/
│   └── SKILL.md                          # 技能入口（编排器循环）
├── .data/agent/background/medtrum-chain/
│   ├── orchestrator.md                   # 备用编排器（旧版，可忽略）
│   ├── plans/                            # 14 个 step 合约
│   │   ├── step-00-cleanup.md
│   │   ├── step-01-linkedin-fetch.md
│   │   ├── step-02-linkedin-process.md
│   │   ├── step-03-tiktok-fetch.md
│   │   ├── step-04-tiktok-process.md
│   │   ├── step-05-instagram-fetch.md
│   │   ├── step-06-instagram-process.md
│   │   ├── step-07-x-fetch.md
│   │   ├── step-08-x-process.md
│   │   ├── step-09-reddit-fetch.md
│   │   ├── step-10-reddit-process.md
│   │   ├── step-11-aggregate.md
│   │   ├── step-12-email-render.md
│   │   └── step-13-email-send.md
│   ├── scripts/                          # 辅助脚本
│   │   ├── extract_for_judgment.py       # 提取 raw JSON → 判断模板
│   │   ├── merge_judgments.py            # 合并判断回 raw JSON
│   │   └── clone_raw.py                  # 备用
│   └── output/                           # conn 产出目录（非 /app/output/）
└── runtime/skills-user/
    ├── linkedin-search-latest/           # 已优化：即时滚动、preflight、JSON
    ├── tiktok-search-latest/             # 已优化
    ├── ins-search-latest/
    │   └── scripts/ins_feed_scroll.mjs   # Instagram 首页刷帖+点赞（替代搜索）
    ├── x-search-latest/                  # 已优化：智能时间停
    ├── reddit-search-latest/             # 已优化
    └── send-email/                       # 邮件发送工具
```

## 两阶段校验体系

| 阶段 | 检索步（01/03/05/07/09） | 处理步（02/04/06/08/10） |
|------|-------------------------|-------------------------|
| **脚本内置** | date/author/content 非空、url 格式 | 无（空 JSON 合法） |
| **合约 bash** | total==len(items)、每字段非空 | summary 非空、relevant∈{yes,uncertain}、sentiment∈{正向,负向,其他} |

## 关键决策记录

1. **不用子 Agent**：编排器直接执行，subagent 启动开销大且容易篡改字段。
2. **Instagram 首页刷帖**：搜索 API 日期过滤有问题，改用首页刷帖+点赞训练算法。
3. **X 智能停**：3 轮全是旧内容时自动停止滚动。
4. **linkedin-search-latest 改造**：
   - `behavior:smooth` → 即时 `scrollTop`（CDP 不执行 CSS 动画）
   - URL 加 `datePosted=["past-month"]`
   - 输出 Markdown → JSON
   - 加 preflight 健康检查（exit 2 = 硬失败不重试）
5. **Instagram Like 要点 SPAN 不能点 SVG**。
6. **conn 工作目录**：产出在 `.data/agent/background/medtrum-chain/output/`，非 `/app/output/`。

## 已知问题

1. **deepseek-v4-flash 判断力有限**：对 LinkedIn 长文约 80% 准确度，会误判非 Medtrum 的 TouchCare 品牌。
2. **Instagram 算法训练中**：初期 0 条 Medtrum 内容，需多轮点赞积累。
3. **X 全是 Marktplaats 转售**：41 条全是荷兰二手平台。
4. **Reddit 收录少**：受反爬限制。

## 测试方法

```bash
# 手动触发
conn run_now 2b40c2c4-baed-4177-b705-4ad199c8184b

# 查看运行状态
conn list_runs 2b40c2c4-baed-4177-b705-4ad199c8184b

# 查看产出
ls -lt /app/.data/agent/background/medtrum-chain/output/

# 单独测试某个检索
node runtime/skills-user/linkedin-search-latest/scripts/linkedin_search_latest.mjs --keyword Medtrum --days 30 | python3 -m json.tool

# 单独测试 Instagram 刷帖
node runtime/skills-user/ins-search-latest/scripts/ins_feed_scroll.mjs 50
```

## 下一步建议

1. 升级模型：处理步用 deepseek-v3 替换 v4-flash 提升判断准确度
2. Instagram 跑 2-3 周积累点赞后评估 Medtrum 内容覆盖
3. 考虑对接飞书机器人推送重点风险条目
