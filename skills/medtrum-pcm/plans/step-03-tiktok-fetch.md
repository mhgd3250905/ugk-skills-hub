# Step 03：TikTok 检索

## 输入
无。

## 任务

⚠️ **串行执行**。依次运行：

```bash
node runtime/skills-user/medtrum-pcm/scripts/tiktok_search.mjs --keyword touchcare --days 30 > output/tiktok-touchcare-raw.json 2>output/tiktok-touchcare-err.txt
node runtime/skills-user/medtrum-pcm/scripts/tiktok_search.mjs --keyword Medtrum --days 30 > output/tiktok-Medtrum-raw.json 2>output/tiktok-Medtrum-err.txt
```

## 输出
- `output/tiktok-touchcare-raw.json`
- `output/tiktok-Medtrum-raw.json`

## 验证命令
```bash
for kw in touchcare Medtrum; do
  f="output/tiktok-${kw}-raw.json"
  [ -s "$f" ] || { echo "❌ ${kw} missing"; continue; }
  if grep -q "PREFLIGHT_FAILED" "output/tiktok-${kw}-err.txt" 2>/dev/null; then
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
done && echo "PASS: step-03"
```

## 验证失败处理
若 err 含 PREFLIGHT_FAILED → 硬失败不重试。否则重试最多 1 次。

## 下一步
`plans/step-04-tiktok-process.md`
