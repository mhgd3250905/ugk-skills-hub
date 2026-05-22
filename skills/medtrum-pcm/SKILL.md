---
name: medtrum-pcm
description: 仅当用户显式输入 /medtrum-pcm 时使用。不要从自然语言问题中猜测触发。执行 Medtrum 多平台舆情监控链式流水线：自动检索 LinkedIn/TikTok/Instagram/X/Reddit 五个平台的 Medtrum/TouchCare 相关内容，逐条判断相关性和舆情情感，生成报告并邮件发送。
allowed-tools: Bash
---

# Medtrum PCM — 多平台舆情监控

## 触发方式

**仅接受显式命令触发：** `/medtrum-pcm`

不要从自然语言中猜测触发。conn 定时任务的 prompt 必须为固定字符串 `/medtrum-pcm`。

```
设 OUTPUT_DIR = "/app/.data/agent/background/medtrum-chain/output"
设 PLANS_DIR = "/app/runtime/skills-user/medtrum-pcm/plans"
设 SCRIPTS_DIR = "/app/runtime/skills-user/medtrum-pcm/scripts"
设 "当前步" = "step-00-cleanup"

循环：
1. 读取 PLANS_DIR/当前步.md
2. 严格按文件中的【任务】说明执行
3. 执行文件中的【验证命令】
4. 验证通过 → 读取文件末尾【下一步】，赋值给当前步
5. 验证失败 → 按文件中的【验证失败处理】执行
6. 当前步 = "TERMINAL" → 退出循环，输出执行汇报
```

起始：读取 `PLANS_DIR/step-00-cleanup.md`。

## 关键原则

1. **逐步揭示**：你只知道当前这一步。每步末尾的【下一步】会告诉你该读哪个文件。不要推测或预判后续步骤。
2. **验证门禁**：每步必须通过验证命令才能进入下一步。验证失败必须按失败处理执行。
3. **逐条判断**：当步骤要求你对 content 逐条判断 relevant/summary/sentiment 时，必须逐条阅读后填写，不能跳过。
4. **所有 bash 命令使用 OUTPUT_DIR 绝对路径**，不要依赖当前工作目录。
