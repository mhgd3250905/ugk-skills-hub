# Step 01：X 检索

## 输入
无。

## 任务

⚠️ **串行执行**。依次运行：

```bash
mkdir -p /app/.data/agent/background/medtrum-spider/x
node /app/runtime/skills-user/medtrum-x-spider/scripts/x_search.mjs --keyword touchcare --days 30 > /app/.data/agent/background/medtrum-spider/x/x-touchcare-raw.json 2>/app/.data/agent/background/medtrum-spider/x/x-touchcare-err.txt
```
```bash
node /app/runtime/skills-user/medtrum-x-spider/scripts/x_search.mjs --keyword Medtrum --days 30 > /app/.data/agent/background/medtrum-spider/x/x-Medtrum-raw.json 2>/app/.data/agent/background/medtrum-spider/x/x-Medtrum-err.txt
```

## 输出
- `/app/.data/agent/background/medtrum-spider/x/x-touchcare-raw.json`
- `/app/.data/agent/background/medtrum-spider/x/x-Medtrum-raw.json`

## 验证命令
```bash
OD="/app/.data/agent/background/medtrum-spider/x"
for kw in touchcare Medtrum; do
  f="$OD/x-${kw}-raw.json"
  [ -s "$f" ] || { echo "FAIL: ${kw} missing"; continue; }
  if grep -q "PREFLIGHT_FAILED" "$OD/x-${kw}-err.txt" 2>/dev/null; then
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
若 err 含 PREFLIGHT_FAILED → 硬失败不重试。否则重试最多 1 次。

## 下一步
`step-02-process`
