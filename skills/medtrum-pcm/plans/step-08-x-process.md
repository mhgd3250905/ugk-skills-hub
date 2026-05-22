# Step 08：X 处理

## 输入
- `output/x-touchcare-raw.json`
- `output/x-Medtrum-raw.json`

## 任务

**第 1 步：提取**
```bash
python3 runtime/skills-user/medtrum-pcm/scripts/extract_for_judgment.py output/x-touchcare-raw.json /tmp/judge-x-tc.json
python3 runtime/skills-user/medtrum-pcm/scripts/extract_for_judgment.py output/x-Medtrum-raw.json /tmp/judge-x-md.json
```

**第 2 步：逐条判断**

读取上述 JSON 文件，对每个元素阅读 `content` 判断：
- relevant：yes（含 Medtrum/TouchCare）| no | uncertain
- summary：≤60 字
- sentiment：正向/负向/其他
- date_iso：读取原始 `date` 字段，转换为 `YYYY-MM-DD HH:MM`（UTC）。如 `"2026-04-14"` → `"2026-04-14 00:00"`。原始 date 为空填 `""`。

**第 3 步：写入**
- `/tmp/judge-x-tc-out.json`
- `/tmp/judge-x-md-out.json`

格式：`[{"index":N, "relevant":"yes", "summary":"...", "sentiment":"正向", "date_iso":"2026-04-14 00:00"}, ...]`

**第 4 步：合并**
```bash
python3 runtime/skills-user/medtrum-pcm/scripts/merge_judgments.py output/x-touchcare-raw.json /tmp/judge-x-tc-out.json output/x-touchcare.json
python3 runtime/skills-user/medtrum-pcm/scripts/merge_judgments.py output/x-Medtrum-raw.json /tmp/judge-x-md-out.json output/x-Medtrum.json
```

## 输出
- `output/x-touchcare.json`
- `output/x-Medtrum.json`

## 验证命令
```bash
for kw in touchcare Medtrum; do
  json="output/x-${kw}.json"
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
done && echo "PASS: step-08"
```

## 验证失败处理
重试最多 1 次。

## 下一步
`plans/step-09-reddit-fetch.md`
