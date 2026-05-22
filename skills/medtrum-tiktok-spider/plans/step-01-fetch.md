# Step 01：TikTok 检索

## 输入
无。

## 任务

⚠️ **串行执行**。依次运行：

```bash
mkdir -p /app/.data/agent/background/medtrum-spider/tiktok
node /app/runtime/skills-user/medtrum-tiktok-spider/scripts/tiktok_search.mjs --keyword touchcare --days 30 > /app/.data/agent/background/medtrum-spider/tiktok/tiktok-touchcare-raw.json 2>/app/.data/agent/background/medtrum-spider/tiktok/tiktok-touchcare-err.txt
```
```bash
node /app/runtime/skills-user/medtrum-tiktok-spider/scripts/tiktok_search.mjs --keyword Medtrum --days 30 > /app/.data/agent/background/medtrum-spider/tiktok/tiktok-Medtrum-raw.json 2>/app/.data/agent/background/medtrum-spider/tiktok/tiktok-Medtrum-err.txt
```

## 输出
- `/app/.data/agent/background/medtrum-spider/tiktok/tiktok-touchcare-raw.json`
- `/app/.data/agent/background/medtrum-spider/tiktok/tiktok-Medtrum-raw.json`

## 验证命令
```bash
OD="/app/.data/agent/background/medtrum-spider/tiktok"
for kw in touchcare Medtrum; do
  f="$OD/tiktok-${kw}-raw.json"
  [ -s "$f" ] || { echo "FAIL: ${kw} missing"; continue; }
  if grep -q "PREFLIGHT_FAILED" "$OD/tiktok-${kw}-err.txt" 2>/dev/null; then
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
脚本内部已对 TikTok 错误页做最多 2 次自动恢复（先点击重试按钮，再 reload 页面）。若仍含 PREFLIGHT_FAILED，允许重试最多 1 次作为额外容错。

## 下一步
`step-02-process`
