# Step 02：TikTok 处理（终点）

## 输入
- `/app/.data/agent/background/medtrum-spider/tiktok/tiktok-touchcare-raw.json`
- `/app/.data/agent/background/medtrum-spider/tiktok/tiktok-Medtrum-raw.json`

## 任务

**第 1 步：提取**
```bash
OD="/app/.data/agent/background/medtrum-spider/tiktok"
python3 /app/runtime/skills-user/medtrum-tiktok-spider/scripts/extract_for_judgment.py "$OD/tiktok-touchcare-raw.json" /tmp/judge-tt-tc.json
python3 /app/runtime/skills-user/medtrum-tiktok-spider/scripts/extract_for_judgment.py "$OD/tiktok-Medtrum-raw.json" /tmp/judge-tt-md.json
```

**第 2 步：逐条判断**

读取上述 JSON 文件，对每个元素阅读 `content` 字段判断：
- **relevant**：`yes`（明确涉及 Medtrum/TouchCare 糖尿病医疗器械）| `no`（无关，如美容、娱乐、流行话题等）| `uncertain`（不确定）
- **summary**：中文概括 ≤60 字。relevant=yes 正常概括；relevant=uncertain 以【待确认】开头。
- **sentiment**：`正向`（好评/推广/正面体验）| `负向`（投诉/召回/警告/安全隐患）| `其他`（中性/普通讨论）
- **date_iso**：读取原始 `date` 字段，根据当前时间转换为 `YYYY-MM-DD HH:MM`（UTC）。如原始为 `"2026-04-20"` → `"2026-04-20 00:00"`；相对时间格式参照 LinkedIn 规则。原始 date 为空时填 `""`。

⚠️ **TikTok 特殊规则**：仅保留内容或发帖人名称含 `medtrum` 或 `touchcare` 关键词的条目。不含关键词的条目无论 relevant 如何都跳过不写入。

**第 3 步：写入判断**
- `/tmp/judge-tt-tc-out.json`
- `/tmp/judge-tt-md-out.json`

格式：`[{"index":N, "relevant":"yes", "summary":"...", "sentiment":"正向", "date_iso":"2026-04-20 00:00"}, ...]`

**第 4 步：合并**
```bash
OD="/app/.data/agent/background/medtrum-spider/tiktok"
python3 /app/runtime/skills-user/medtrum-tiktok-spider/scripts/merge_judgments.py "$OD/tiktok-touchcare-raw.json" /tmp/judge-tt-tc-out.json "$OD/tiktok-touchcare.json"
python3 /app/runtime/skills-user/medtrum-tiktok-spider/scripts/merge_judgments.py "$OD/tiktok-Medtrum-raw.json" /tmp/judge-tt-md-out.json "$OD/tiktok-Medtrum.json"

# 入库到共享 SQLite
python3 /app/.data/agent/background/medtrum-spider/shared/ingest.py "$OD/tiktok-touchcare.json" "$OD/tiktok-Medtrum.json"

# 验证入库数据一致性
python3 /app/.data/agent/background/medtrum-spider/shared/verify_ingest.py --fix "$OD/tiktok-touchcare.json" "$OD/tiktok-Medtrum.json"
```

## 输出
- `/app/.data/agent/background/medtrum-spider/tiktok/tiktok-touchcare.json`
- `/app/.data/agent/background/medtrum-spider/tiktok/tiktok-Medtrum.json`

## 验证命令
```bash
OD="/app/.data/agent/background/medtrum-spider/tiktok"
for kw in touchcare Medtrum; do
  json="$OD/tiktok-${kw}.json"
  [ -s "$json" ] || { echo "FAIL: $kw missing"; continue; }
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
        assert re.match(r'^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$', diso), f'invalid date_iso: {diso}'
print('ok')
" && echo "PASS: $kw" || echo "FAIL: $kw"
done
```

## 验证失败处理
重试最多 1 次。

## 下一步
`step-03-report-html`

