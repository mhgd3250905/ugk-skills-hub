# Step 01：Instagram 检索（首页刷帖+点赞）

## 输入
无。

## 任务

运行首页刷帖脚本（50条，同时点赞糖尿病/Medtrum内容训练算法）：

```bash
mkdir -p /app/.data/agent/background/medtrum-spider/instagram
node /app/runtime/skills-user/medtrum-instagram-spider/scripts/ins_feed_scroll.mjs 50 > /app/.data/agent/background/medtrum-spider/instagram/instagram-raw.json 2>/app/.data/agent/background/medtrum-spider/instagram/instagram-err.txt
```

## 输出
`/app/.data/agent/background/medtrum-spider/instagram/instagram-raw.json`

## 验证命令
```bash
OD="/app/.data/agent/background/medtrum-spider/instagram"
f="$OD/instagram-raw.json"
[ -s "$f" ] || { echo "FAIL: missing"; }
if grep -q "PREFLIGHT_FAILED" "$OD/instagram-err.txt" 2>/dev/null; then echo "FAIL: HARD_FAIL"; fi
python3 -c "
import json; d=json.load(open('$f'))
assert 'items' in d
assert d['total']==len(d['items'])
for item in d['items']:
    assert item.get('author','').strip(), 'empty author'
    assert item.get('content','').strip(), 'empty content'
print(f'OK: {d[\"total\"]} posts, {d.get(\"scrollNote\",\"\")}')
" && echo "PASS: step-01" || echo "FAIL: step-01"
```

## 验证失败处理
PREFLIGHT_FAILED → 硬失败不重试。否则重试最多 1 次。

## 下一步
`step-02-process`
