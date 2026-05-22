# UGK Skills Hub

集中管理分散在各处的 Agent 技能。

## 目录结构

```
skills/
├── github-helper/              ← GitHub 综合技能（检索 + 管理）
├── medtrum-pcm/                ← Medtrum 多平台舆情监控流水线
├── medtrum-instagram-spider/   ← Instagram 舆情采集
├── medtrum-linkedin-spider/    ← LinkedIn 舆情采集
├── medtrum-reddit-spider/      ← Reddit 舆情采集
├── medtrum-tiktok-spider/      ← TikTok 舆情采集
├── medtrum-x-spider/           ← X(Twitter) 舆情采集
├── medtrum-view/               ← 舆情报告 HTML 生成
├── ptt-data/                   ← 台湾 PTT 批踢踢数据查询
├── reddit-data/                ← Reddit 帖子、评论、子版块数据
├── send-email/                 ← 邮件发送（SMTP）
├── xhs-helper/                 ← 小红书笔记发布、检索
├── zhihu-helper/               ← 知乎热榜、回答、收藏夹
└── ...                         ← 更多技能陆续迁入
```

## 技能说明

每个技能目录包含：
- `SKILL.md` — 技能定义和使用说明
- `scripts/` — 执行脚本
- `references/` — 参考文档
- `plans/` — 执行计划（如有）
- `templates/` — 模板文件（如有）
- `evals/` — 测试用例（如有）
