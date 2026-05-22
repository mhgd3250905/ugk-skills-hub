# Step 03：生成报告 HTML

## 输入
无（直接读取共享 SQLite）

## 任务

从 SQLite 读取全量数据，生成内联样式的报告 HTML。按 medtrum-view 技能规范写入 `$ARTIFACT_PUBLIC_DIR`：

```bash
python3 /app/.data/agent/background/medtrum-spider/shared/generate_report.py
```

## 输出
`$ARTIFACT_PUBLIC_DIR/medtrum-view/medtrum-report.html` — 报告 HTML（内联样式，适合 PDF 打印）

## 验证命令
```bash
F="$ARTIFACT_PUBLIC_DIR/medtrum-view/medtrum-report.html"
[ -s "$F" ] && python3 -c "
import re
h = open('$F').read()
assert len(h) > 1000, 'too short'
assert '每日 Medtrum 多平台多关键词舆情监测报告' in h, 'missing title'
assert '各平台舆情汇总' in h, 'missing platform table'
assert '各平台分析' in h, 'missing platform analysis'
assert '舆情记录明细' in h, 'missing detail section'
assert '结论与建议' in h, 'missing conclusion'
assert '局限性' in h, 'missing limitations'
classes = re.findall(r'class="', h)
assert len(classes) == 0, f'{len(classes)} CSS class refs found'
print(f'PASS: step-03 ({len(h)} chars)')
" || echo "FAIL: step-03"
```
## 验证失败处理
重试最多 1 次。仍失败标记 `报告 HTML 生成失败`，继续下一步（不阻塞后续步骤）。

## 下一步
`step-04-report-pdf`
