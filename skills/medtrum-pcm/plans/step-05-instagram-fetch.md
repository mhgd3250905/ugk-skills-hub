# Step 05：Instagram 检索（首页刷帖+点赞）

## 输入
无。

## 任务

运行首页刷帖脚本（50条，同时点赞糖尿病/Medtrum内容训练算法）：

```bash
node runtime/skills-user/medtrum-pcm/scripts/ins_feed_scroll.mjs 50 > output/instagram-raw.json 2>output/instagram-err.txt
```

## 输出
`output/instagram-raw.json`

## 验证命令
```bash
f="output/instagram-raw.json"; [ -s "$f" ] || { echo "❌ missing"; exit 1; }
if grep -q "PREFLIGHT_FAILED" output/instagram-err.txt 2>/dev/null; then echo "❌ HARD_FAIL"; exit 1; fi
python3 -c "
import json; d=json.load(open('$f'))
assert 'items' in d
assert d['total']==len(d['items'])
for item in d['items']:
    assert item.get('author','').strip(), 'empty author'
    assert item.get('content','').strip(), 'empty content'
print(f'OK: {d[\"total\"]} posts, {d.get(\"scrollNote\",\"\")}')
" && echo "PASS: step-05"
```

## 验证失败处理
PREFLIGHT_FAILED → 硬失败不重试。否则重试最多 1 次。

## 下一步
`plans/step-06-instagram-process.md`
