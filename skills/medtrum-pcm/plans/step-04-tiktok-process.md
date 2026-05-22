# Step 04：TikTok 处理

## 输入
- `output/tiktok-touchcare-raw.json`
- `output/tiktok-Medtrum-raw.json`

## 任务

**第 1 步：提取**
```bash
python3 runtime/skills-user/medtrum-pcm/scripts/extract_for_judgment.py output/tiktok-touchcare-raw.json /tmp/judge-tt-tc.json
python3 runtime/skills-user/medtrum-pcm/scripts/extract_for_judgment.py output/tiktok-Medtrum-raw.json /tmp/judge-tt-md.json
```

**第 2 步：逐条判断**

读取上述 JSON 文件，对每个元素阅读 `content` 字段判断：
- **relevant**：yes / no / uncertain（同上规则）
- **summary**：中文 ≤60 字
- **sentiment**：正向 / 负向 / 其他
- **date_iso**：读取原始 `date` 字段，转换为 `YYYY-MM-DD HH:MM`（UTC）。如 `"2026-04-20"` → `"2026-04-20 00:00"`。原始 date 为空填 `""`。

⚠️ relevant=no 跳过不写。仅保留含 `medtrum` 或 `touchcare` 关键词的条目。

**第 3 步：写入判断**
- `/tmp/judge-tt-tc-out.json`
- `/tmp/judge-tt-md-out.json`

格式同 Step 02：`[{"index":N, "relevant":"yes", "summary":"...", "sentiment":"正向", "date_iso":"2026-04-20 00:00"}, ...]`

**第 4 步：合并**
```bash
python3 runtime/skills-user/medtrum-pcm/scripts/merge_judgments.py output/tiktok-touchcare-raw.json /tmp/judge-tt-tc-out.json output/tiktok-touchcare.json
python3 runtime/skills-user/medtrum-pcm/scripts/merge_judgments.py output/tiktok-Medtrum-raw.json /tmp/judge-tt-md-out.json output/tiktok-Medtrum.json
```

## 输出
- `output/tiktok-touchcare.json`
- `output/tiktok-Medtrum.json`

## 验证命令
```bash
for kw in touchcare Medtrum; do
  json="output/tiktok-${kw}.json"
  [ -s "$json" ] || { echo "❌ $kw missing"; continue; }
  python3 -c "
import json; d=json.load(open('$json'))
assert d['total']==len(d['items'])
for item in d['items']:
    assert item.get('summary','')!=''
    assert item.get('relevant') in ('yes','uncertain')
    assert item.get('sentiment') in ('正向','负向','其他')
    diso = item.get('date_iso','')
    if diso:
        import re
        assert re.match(r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$', diso), f'invalid date_iso'
print('ok')
" && echo "✅ $kw" || echo "❌ $kw"
done && echo "PASS: step-04"
```

## 验证失败处理
重试最多 1 次。仍失败标记，继续下一步。

## 下一步
`plans/step-05-instagram-fetch.md`
