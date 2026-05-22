# Step 10：Reddit 处理

## 输入
- `output/reddit-touchcare-raw.json`
- `output/reddit-Medtrum-raw.json`

## 任务

**第 1 步：提取**
```bash
python3 runtime/skills-user/medtrum-pcm/scripts/extract_for_judgment.py output/reddit-touchcare-raw.json /tmp/judge-rd-tc.json
python3 runtime/skills-user/medtrum-pcm/scripts/extract_for_judgment.py output/reddit-Medtrum-raw.json /tmp/judge-rd-md.json
```

**第 2 步：逐条判断**

分别读取 `/tmp/judge-rd-tc.json` 和 `/tmp/judge-rd-md.json`。

对每条阅读 `content`，判断 relevant/summary/sentiment/date_iso。

- **date_iso**：读取原始 `date` 字段，转换为 `YYYY-MM-DD HH:MM`（UTC）。如 `"2026-04-30"` → `"2026-04-30 00:00"`。原始 date 为空填 `""`。

仅保留含 `medtrum` 或 `touchcare` 或 `nano` 或 `cgm` 且明显涉及糖尿病医疗器械的条目。

**第 3 步：写入**
- `/tmp/judge-rd-tc-out.json`
- `/tmp/judge-rd-md-out.json`

格式：`[{"index":N, "relevant":"yes", "summary":"...", "sentiment":"正向", "date_iso":"2026-04-30 00:00"}, ...]`

**第 4 步：合并**
```bash
python3 runtime/skills-user/medtrum-pcm/scripts/merge_judgments.py output/reddit-touchcare-raw.json /tmp/judge-rd-tc-out.json output/reddit-touchcare.json
python3 runtime/skills-user/medtrum-pcm/scripts/merge_judgments.py output/reddit-Medtrum-raw.json /tmp/judge-rd-md-out.json output/reddit-Medtrum.json
```

## 输出
- `output/reddit-touchcare.json`
- `output/reddit-Medtrum.json`

## 验证命令
```bash
for kw in touchcare Medtrum; do
  json="output/reddit-${kw}.json"
  [ -s "$json" ] || { echo "❌ $kw missing"; continue; }
  python3 -c "
import json; d=json.load(open('$json'))
assert d['total']==len(d['items'])
for item in d['items']:
    assert item['summary']!=''
    assert item['relevant'] in ('yes','uncertain')
    assert item['sentiment'] in ('正向','负向','其他')
    diso = item.get('date_iso','')
    if diso:
        import re
        assert re.match(r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$', diso), f'invalid date_iso'
print('ok')
" && echo "✅ $kw" || echo "❌ $kw"
done && echo "PASS: step-10"
```

## 验证失败处理
重试最多 1 次。

## 下一步
`plans/step-11-html-render.md`
