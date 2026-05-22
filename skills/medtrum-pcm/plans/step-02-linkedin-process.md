# Step 02：LinkedIn 处理

## 输入
- `output/linkedin-touchcare-raw.json`
- `output/linkedin-Medtrum-raw.json`

## 任务

**第 1 步：提取**
```bash
python3 runtime/skills-user/medtrum-pcm/scripts/extract_for_judgment.py output/linkedin-touchcare-raw.json /tmp/judge-li-tc.json
python3 runtime/skills-user/medtrum-pcm/scripts/extract_for_judgment.py output/linkedin-Medtrum-raw.json /tmp/judge-li-md.json
```

**第 2 步：逐条判断**

分别读取 `/tmp/judge-li-tc.json` 和 `/tmp/judge-li-md.json`。

每个文件是一个 JSON 数组，每个元素包含 `index`、`date`、`author`、`content` 字段。

对每个元素，阅读其 `content` 字段的内容，判断：

1. **relevant**：`yes`（明确涉及 Medtrum/TouchCare 糖尿病医疗器械）| `no`（无关，如 TouchCare 美国健康福利公司、美容护理、娱乐等）| `uncertain`（不确定）
2. **summary**：中文概括 ≤60 字。relevant=yes 正常概括；relevant=uncertain 以【待确认】开头。
3. **sentiment**：`正向`（好评/推广/正面体验）| `负向`（投诉/召回/警告/安全隐患）| `其他`（中性/招聘/人事/市场报告）
4. **date_iso**：读取原始 `date` 字段，根据当前时间转换为 `YYYY-MM-DD HH:MM`（UTC）。推算规则：`"12 小时"` → 当前时间减12小时；`"1 天"` → 减1天；`"1 周"` → 减7天；`"20 minutes"` → 减20分钟；`"2026-04-20"` → `"2026-04-20 00:00"`。原始 date 为空时填 `""`。

⚠️ relevant=no 的条目跳过不写入。

**第 3 步：写入判断**

将判断结果写入对应的输出文件：
- `/tmp/judge-li-tc-out.json`（touchcare）
- `/tmp/judge-li-md-out.json`（Medtrum）

每个输出文件的格式是一个 JSON 数组，每个元素包含：
```json
{"index": 0, "relevant": "yes", "summary": "中文概括", "sentiment": "正向", "date_iso": "2026-05-06 14:30"}
```

**第 4 步：合并**
```bash
python3 runtime/skills-user/medtrum-pcm/scripts/merge_judgments.py output/linkedin-touchcare-raw.json /tmp/judge-li-tc-out.json output/linkedin-touchcare.json
python3 runtime/skills-user/medtrum-pcm/scripts/merge_judgments.py output/linkedin-Medtrum-raw.json /tmp/judge-li-md-out.json output/linkedin-Medtrum.json
```

合并脚本自动从 raw JSON 复制原始字段。你填写的 summary/relevant/sentiment 覆盖到最终 JSON。

## 输出
- `output/linkedin-touchcare.json`
- `output/linkedin-Medtrum.json`

## 验证命令
```bash
for kw in touchcare Medtrum; do
  json="output/linkedin-${kw}.json"
  [ -s "$json" ] || { echo "❌ $kw missing"; continue; }
  python3 -c "
import json; d=json.load(open('$json'))
assert d['total']==len(d['items']), 'total mismatch'
for item in d['items']:
    assert item.get('summary','')!='', 'empty summary'
    assert item.get('relevant') in ('yes','uncertain'), 'invalid relevant'
    assert item.get('sentiment') in ('正向','负向','其他'), 'invalid sentiment'
    diso = item.get('date_iso','')
    if diso:
        import re
        assert re.match(r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$', diso), f'invalid date_iso: {repr(diso)}'
print('ok')
" && echo "✅ $kw" || echo "❌ $kw"
done && echo "PASS: step-02"
```

## 验证失败处理
重试最多 1 次。仍失败标记 `LinkedIn 处理失败`，继续下一步。

## 下一步
`plans/step-03-tiktok-fetch.md`
