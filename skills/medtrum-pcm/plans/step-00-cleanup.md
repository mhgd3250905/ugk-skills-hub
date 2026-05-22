# Step 00：清理上一轮输出

## 输入
无。

## 任务

直接执行以下命令清空输出目录：

```bash
OUTPUT_DIR="/app/.data/agent/background/medtrum-chain/output"
mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_DIR"/*.md "$OUTPUT_DIR"/*.json "$OUTPUT_DIR"/*.txt "$OUTPUT_DIR"/*.html
```

清理后确认目录为空。

## 输出
无文件输出。output/ 目录存在且为空。

## 验证命令
```bash
test -d output/ && [ -z "$(ls -A output/ 2>/dev/null)" ] && echo "PASS: step-00" || echo "FAIL: step-00"
```

## 验证失败处理
重试最多 1 次。仍失败终止流水线。

## 下一步
`plans/step-01-linkedin-fetch.md`
