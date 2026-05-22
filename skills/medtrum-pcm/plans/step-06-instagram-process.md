# Step 06：Instagram 处理

## 输入
`output/instagram-raw.json`

## 任务

**第 1 步：提取**
```bash
python3 runtime/skills-user/medtrum-pcm/scripts/extract_for_judgment.py output/instagram-raw.json /tmp/judge-ig.json
```

**第 2 步：逐条判断**

读取 `/tmp/judge-ig.json`。仅保留内容或作者含 `medtrum` 或 `touchcare` 关键词的条目。

对每条判断：relevant（yes/uncertain）、summary（≤60字）、sentiment（正向/负向/其他）、date_iso（读取原始 `date`，转换为 `YYYY-MM-DD HH:MM`，为空填 `""`）。

**第 3 步：写入**
`/tmp/judge-ig-out.json`

格式：`[{"index":N, "relevant":"yes", "summary":"...", "sentiment":"正向", "date_iso":"2026-05-06 14:30"}, ...]`

**第 4 步：合并**
```bash
python3 runtime/skills-user/medtrum-pcm/scripts/merge_judgments.py output/instagram-raw.json /tmp/judge-ig-out.json output/instagram.json
```

## 输出
`output/instagram.json`

## 验证命令
```bash
json="output/instagram.json"
[ -s "$json" ] || { echo "❌ missing"; exit 1; }
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
" && echo "PASS: step-06"
```

## 验证失败处理
重试最多 1 次。

## 下一步
`plans/step-07-x-fetch.md`
