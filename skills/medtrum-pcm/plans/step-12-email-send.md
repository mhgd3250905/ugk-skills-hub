# Step 12：邮件发送（终点）

## 输入
`output/final-report-email.html` — 邮件 HTML

## 任务

不创建子 Agent。你（编排器）直接执行发送命令：

```bash
node runtime/skills-user/send-email/scripts/email_sender.mjs \
  -t "294851575@qq.com,ning.zhou@medtrum.com" \
  -s "每日 Medtrum 多平台多关键词舆情监测报告" \
  --html \
  -b "$(cat output/final-report-email.html)"
```

发送失败处理：
- 最多重试 2 次
- 若最终失败，汇报"邮件发送失败，但核心舆情检索与汇总已完成"

## 输出
无文件输出。stdout 包含 Message-ID 即为成功。

## 验证命令
检查退出码为 0 且 stdout 含 `Message-ID`。

## 验证失败处理
重试最多 2 次。最终失败记录 `邮件发送失败`，不阻塞收口。

## 下一步
`TERMINAL` — 流水线结束。

---

验证通过后，输出最终汇报：

```
## 执行结果概览
| 步骤 | 状态 | 产出 | 说明 |
|------|------|------|------|
| 步骤 0：清理 | ✅/❌ | output/ | |
| 步骤 1：LinkedIn 检索 | ✅/❌ | output/linkedin-*-raw.json | |
| 步骤 2：LinkedIn 处理 | ✅/❌ | output/linkedin-*.json | |
| 步骤 3：TikTok 检索 | ✅/❌ | output/tiktok-*-raw.json | |
| 步骤 4：TikTok 处理 | ✅/❌ | output/tiktok-*.json | |
| 步骤 5：Instagram 检索 | ✅/❌ | output/instagram-raw.json | |
| 步骤 6：Instagram 处理 | ✅/❌ | output/instagram.json | |
| 步骤 7：X 检索 | ✅/❌ | output/x-*-raw.json | |
| 步骤 8：X 处理 | ✅/❌ | output/x-*.json | |
| 步骤 9：Reddit 检索 | ✅/❌ | output/reddit-*-raw.json | |
| 步骤 10：Reddit 处理 | ✅/❌ | output/reddit-*.json | |
| 步骤 11：HTML 渲染 | ✅/❌ | output/final-report-email.html | |
| 步骤 12：邮件发送 | ✅/❌ | - | 邮件已发送 / 发送失败 |

产出目录：output/
```
