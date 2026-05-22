# Step 01：Reddit 检索

## 输入
无。

## 任务

⚠️ **串行执行**：

```bash
mkdir -p /app/.data/agent/background/medtrum-spider/reddit
node /app/runtime/skills-user/medtrum-reddit-spider/scripts/reddit_search.mjs touchcare 30 > /app/.data/agent/background/medtrum-spider/reddit/reddit-touchcare-raw.json 2>/app/.data/agent/background/medtrum-spider/reddit/reddit-touchcare-err.txt
```
```bash
node /app/runtime/skills-user/medtrum-reddit-spider/scripts/reddit_search.mjs Medtrum 30 > /app/.data/agent/background/medtrum-spider/reddit/reddit-Medtrum-raw.json 2>/app/.data/agent/background/medtrum-spider/reddit/reddit-Medtrum-err.txt
```

## 输出
- `/app/.data/agent/background/medtrum-spider/reddit/reddit-touchcare-raw.json`
- `/app/.data/agent/background/medtrum-spider/reddit/reddit-Medtrum-raw.json`

## 验证命令
```bash
OD="/app/.data/agent/background/medtrum-spider/reddit"
for kw in touchcare Medtrum; do
  f="$OD/reddit-${kw}-raw.json"
  [ -s "$f" ] || { echo "FAIL: ${kw} missing"; continue; }
  if grep -q "PREFLIGHT_FAILED" "$OD/reddit-${kw}-err.txt" 2>/dev/null; then
    echo "FAIL: ${kw} HARD_FAIL" && continue
  fi
  python3 -c "
import json; d=json.load(open('$f'))
assert 'items' in d
assert d['total']==len(d['items'])
for item in d['items']:
    assert item.get('date','').strip(), 'empty date'
    assert item.get('author','').strip(), 'empty author'
    assert item.get('content','').strip(), 'empty content'
print(f'OK: {d[\"total\"]} items, dropped {d.get(\"dropped\",0)}')
" && echo "PASS: ${kw}" || echo "FAIL: ${kw} invalid"
done
```

## 验证失败处理
PREFLIGHT_FAILED → 硬失败不重试。否则重试最多 1 次。

## 下一步
`step-02-process`
