# Step 02：Reddit 处理（终点）

## 输入
- `/app/.data/agent/background/medtrum-spider/reddit/reddit-touchcare-raw.json`
- `/app/.data/agent/background/medtrum-spider/reddit/reddit-Medtrum-raw.json`

## 任务

**第 1 步：提取**
```bash
OD="/app/.data/agent/background/medtrum-spider/reddit"
python3 /app/runtime/skills-user/medtrum-reddit-spider/scripts/extract_for_judgment.py "$OD/reddit-touchcare-raw.json" /tmp/judge-rd-tc.json
python3 /app/runtime/skills-user/medtrum-reddit-spider/scripts/extract_for_judgment.py "$OD/reddit-Medtrum-raw.json" /tmp/judge-rd-md.json
```

**第 2 步：逐条判断**

分别读取 `/tmp/judge-rd-tc.json` 和 `/tmp/judge-rd-md.json`。

对每条阅读 `content`，判断：
- **relevant**：`yes`（明确涉及 Medtrum/TouchCare 糖尿病医疗器械）| `no`（无关）| `uncertain`（不确定）
- **summary**：中文概括 ≤60 字。relevant=yes 正常概括；relevant=uncertain 以【待确认】开头。
- **sentiment**：`正向`（好评/推广/正面体验）| `负向`（投诉/召回/警告/安全隐患）| `其他`（中性/招聘/人事/市场报告）
- **date_iso**：读取原始 `date` 字段，根据当前时间转换为 `YYYY-MM-DD HH:MM`（UTC）。如原始为 `"2026-04-30"` → `"2026-04-30 00:00"`；相对时间参照 LinkedIn 规则。原始 date 为空时填 `""`。

⚠️ **Reddit 特殊规则**：仅保留内容含 `medtrum` 或 `touchcare` 或 `nano` 或 `cgm` 且明显涉及糖尿病医疗器械的条目。无关帖子跳过不写入。

**第 3 步：写入**
- `/tmp/judge-rd-tc-out.json`
- `/tmp/judge-rd-md-out.json`

格式：`[{"index":N, "relevant":"yes", "summary":"...", "sentiment":"正向", "date_iso":"2026-04-30 00:00"}, ...]`

**第 4 步：合并**
```bash
OD="/app/.data/agent/background/medtrum-spider/reddit"
python3 /app/runtime/skills-user/medtrum-reddit-spider/scripts/merge_judgments.py "$OD/reddit-touchcare-raw.json" /tmp/judge-rd-tc-out.json "$OD/reddit-touchcare.json"
python3 /app/runtime/skills-user/medtrum-reddit-spider/scripts/merge_judgments.py "$OD/reddit-Medtrum-raw.json" /tmp/judge-rd-md-out.json "$OD/reddit-Medtrum.json"

# 入库到共享 SQLite
python3 /app/.data/agent/background/medtrum-spider/shared/ingest.py "$OD/reddit-touchcare.json" "$OD/reddit-Medtrum.json"

# 验证入库数据一致性
python3 /app/.data/agent/background/medtrum-spider/shared/verify_ingest.py --fix "$OD/reddit-touchcare.json" "$OD/reddit-Medtrum.json"
```

## 输出
- `/app/.data/agent/background/medtrum-spider/reddit/reddit-touchcare.json`
- `/app/.data/agent/background/medtrum-spider/reddit/reddit-Medtrum.json`

## 验证命令
```bash
OD="/app/.data/agent/background/medtrum-spider/reddit"
for kw in touchcare Medtrum; do
  json="$OD/reddit-${kw}.json"
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

