# Step 01：LinkedIn 检索

## 输入
无。

## 任务

⚠️ **串行执行**。依次为每个关键词运行检索脚本（每个 timeout=300s）：

**关键词 1：touchcare**
```bash
mkdir -p /app/.data/agent/background/medtrum-spider/linkedin
node /app/runtime/skills-user/medtrum-linkedin-spider/scripts/linkedin_search.mjs --keyword touchcare --days 30 > /app/.data/agent/background/medtrum-spider/linkedin/linkedin-touchcare-raw.json 2>/app/.data/agent/background/medtrum-spider/linkedin/linkedin-touchcare-err.txt
```

**关键词 2：Medtrum**（等上一个完成后执行）
```bash
node /app/runtime/skills-user/medtrum-linkedin-spider/scripts/linkedin_search.mjs --keyword Medtrum --days 30 > /app/.data/agent/background/medtrum-spider/linkedin/linkedin-Medtrum-raw.json 2>/app/.data/agent/background/medtrum-spider/linkedin/linkedin-Medtrum-err.txt
```

## 输出
- `/app/.data/agent/background/medtrum-spider/linkedin/linkedin-touchcare-raw.json`
- `/app/.data/agent/background/medtrum-spider/linkedin/linkedin-Medtrum-raw.json`

## 验证命令
```bash
OD="/app/.data/agent/background/medtrum-spider/linkedin"
for kw in touchcare Medtrum; do
  f="$OD/linkedin-${kw}-raw.json"
  [ -s "$f" ] || { echo "FAIL: $kw missing"; continue; }
  if grep -q "PREFLIGHT_FAILED" "$OD/linkedin-${kw}-err.txt" 2>/dev/null; then
    echo "FAIL: $kw HARD_FAIL (preflight)" && continue
  fi
  python3 -c "
import json
d=json.load(open('$f'))
assert 'items' in d
assert d['total']==len(d['items'])
for i in d['items']:
    assert i.get('date')
    assert i.get('authorHandle')
    assert i.get('content')
print(f'PASS: $kw ({d[\"total\"]})')
" 2>/dev/null && echo "" || echo "FAIL: $kw invalid"
done
```

## 验证失败处理
若 err 文件含 `PREFLIGHT_FAILED`：标记硬失败，不重试该关键词。否则重试缺失的关键词最多 1 次。仍失败标记 `LinkedIn 检索失败`，仍继续下一步。

## 下一步
`step-02-process`
