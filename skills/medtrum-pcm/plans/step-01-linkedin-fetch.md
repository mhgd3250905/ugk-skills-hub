# Step 01：LinkedIn 检索

## 输入
无。

## 任务

⚠️ 从项目根目录 `/app` 执行。输出使用相对路径 `output/`。

⚠️ **串行执行**。依次为每个关键词运行检索脚本（每个 timeout=300s）：

**关键词 1：touchcare**
```bash
node runtime/skills-user/medtrum-pcm/scripts/linkedin_search.mjs --keyword touchcare --days 30 > output/linkedin-touchcare-raw.json 2>output/linkedin-touchcare-err.txt
```

**关键词 2：Medtrum**（等上一个完成后执行）
```bash
node runtime/skills-user/medtrum-pcm/scripts/linkedin_search.mjs --keyword Medtrum --days 30 > output/linkedin-Medtrum-raw.json 2>output/linkedin-Medtrum-err.txt
```

## 输出
- `output/linkedin-touchcare-raw.json`
- `output/linkedin-Medtrum-raw.json`

## 验证命令
```bash
for kw in touchcare Medtrum; do
  f="output/linkedin-${kw}-raw.json"
  [ -s "$f" ] || { echo "FAIL: $kw missing"; continue; }
  if grep -q "PREFLIGHT_FAILED" "output/linkedin-${kw}-err.txt" 2>/dev/null; then
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
done && echo "PASS: step-01"
```

## 验证失败处理
若 err 文件含 `PREFLIGHT_FAILED`：标记 `LinkedIn 检索硬失败（登录态丢失/页面异常）`，不重试，跳过该平台。
否则重试缺失的关键词最多 1 次。仍失败标记 `LinkedIn 检索失败`，继续下一步。

## 下一步
`plans/step-02-linkedin-process.md`
