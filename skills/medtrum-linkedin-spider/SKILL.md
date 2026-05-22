---
name: medtrum-linkedin-spider
description: 仅当用户显式输入 /medtrum-linkedin 时使用。独立运行 LinkedIn 平台 Medtrum 舆情采集+处理：检索 touchcare 和 Medtrum 关键词最近30天内容，逐条判断相关性和情感，输出处理后 JSON。
allowed-tools: Bash
---

# Medtrum LinkedIn Spider

## 触发方式
**仅接受显式命令触发：** `/medtrum-linkedin`

## 逐步揭示编排

```
设 OUTPUT_DIR = "/app/.data/agent/background/medtrum-spider/linkedin"
设 PLANS_DIR = "/app/runtime/skills-user/medtrum-linkedin-spider/plans"
设 "当前步" = "step-01-fetch"

循环：
1. 读取 PLANS_DIR/当前步.md
2. 严格按文件中的【任务】说明执行
3. 执行文件中的【验证命令】
4. 验证通过 → 读取文件末尾【下一步】，赋值给当前步
5. 验证失败 → 按文件中的【验证失败处理】执行
6. 当前步 = "TERMINAL" → 退出循环

退出后输出最终汇报：
- 检索关键词和条目数
- 判断结果分布（正向/负向/其他）
- 产出文件列表
```

起始：读取 `PLANS_DIR/step-01-fetch.md`。

## 关键原则
1. 逐步揭示：执行 step-01 时不知道 step-02 的内容
2. 验证门禁：每步必须通过验证才能进入下一步
3. 逐条判断：step-02 必须逐条阅读 content 后填写 relevant/summary/sentiment
4. 所有 bash 命令使用绝对路径
