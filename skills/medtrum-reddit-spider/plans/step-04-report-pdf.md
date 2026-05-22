# Step 04：HTML 转 PDF

## 输入
`$ARTIFACT_PUBLIC_DIR/medtrum-view/medtrum-report.html` — 报告 HTML

## 任务

通过 Chrome CDP 将报告 HTML 转换为 A4 PDF，文件名带 UTC 时间戳，统一写入 `$ARTIFACT_PUBLIC_DIR`：

```bash
D="$ARTIFACT_PUBLIC_DIR/medtrum-view"
TS=$(date -u +%Y%m%dT%H%MZ)
PDF_NAME="medtrum-report-${TS}.pdf"

# 生成带时间戳的 PDF
node /app/.data/agent/background/medtrum-spider/shared/html_to_pdf.cjs \
  "$D/medtrum-report.html" \
  "$D/${PDF_NAME}"

# 写入最新文件名标记（供 generate.py 读取设置下载按钮）
echo "$PDF_NAME" > "$D/.pdf-latest.txt"

# 清理旧 PDF（保留最新 5 个）
ls -1t "$D"/medtrum-report-*.pdf 2>/dev/null | tail -n +6 | xargs -r rm -f
```

## 输出
- `$ARTIFACT_PUBLIC_DIR/medtrum-view/medtrum-report-YYYYMMDDTHHmmZ.pdf` — 带时间戳的 PDF 报告
- `$ARTIFACT_PUBLIC_DIR/medtrum-view/.pdf-latest.txt` — 最新 PDF 文件名

## 验证命令
```bash
D="$ARTIFACT_PUBLIC_DIR/medtrum-view"
PDF_NAME=$(cat "$D/.pdf-latest.txt" 2>/dev/null)
[ -n "$PDF_NAME" ] && [ -s "$D/$PDF_NAME" ] && python3 -c "
h = open('$D/$PDF_NAME','rb').read(10)
assert h.startswith(b'%PDF'), 'not a PDF'
import os
print(f'PASS: step-04 $PDF_NAME ({os.path.getsize(\"$D/$PDF_NAME\")} bytes)')
" || echo "FAIL: step-04"
```

## 验证失败处理
重试最多 1 次。仍失败标记 `PDF 生成失败`，继续下一步（不阻塞页面刷新）。

## 下一步
`step-05-refresh`
