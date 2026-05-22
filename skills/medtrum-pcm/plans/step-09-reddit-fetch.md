# Step 09：Reddit 检索

## 输入
无。

## 任务

⚠️ **串行执行**：

```bash
python3 runtime/skills-user/medtrum-pcm/scripts/reddit_search.py touchcare 30 > output/reddit-touchcare-raw.json 2>output/reddit-touchcare-err.txt
python3 runtime/skills-user/medtrum-pcm/scripts/reddit_search.py Medtrum 30 > output/reddit-Medtrum-raw.json 2>output/reddit-Medtrum-err.txt
```

## 输出
- `output/reddit-touchcare-raw.json`
- `output/reddit-Medtrum-raw.json`

## 验证命令
```bash
for kw in touchcare Medtrum; do
  f="output/reddit-${kw}-raw.json"
  [ -s "$f" ] || { echo "❌ ${kw} missing"; continue; }
  if grep -qE "PREFLIGHT_FAILED|HARD_FAIL" "output/reddit-${kw}-err.txt" 2>/dev/null; then
    echo "❌ ${kw} HARD_FAIL" && continue
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
" && echo "✅ ${kw}" || echo "❌ ${kw} invalid"
done && echo "PASS: step-09"
```

## 验证失败处理
PREFLIGHT_FAILED → 硬失败不重试。否则重试最多 1 次。

## 下一步
`plans/step-10-reddit-process.md`
