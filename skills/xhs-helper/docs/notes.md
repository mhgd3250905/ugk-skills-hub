# 获取笔记数据

从创作者平台获取笔记列表和统计数据。

## 用法

```bash
AGENT_SCOPE="xhs-notes"
TARGET_ID=$(curl -s "http://127.0.0.1:3456/new?url=https://creator.xiaohongshu.com/publish/note&metaAgentScope=${AGENT_SCOPE}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('targetId',''))")
sleep 4

# 获取笔记列表
curl -s -X POST "http://127.0.0.1:3456/eval?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}" \
  -H "Content-Type: application/json" \
  -d @scripts/extract-notes.js | python3 -c "import sys,json; print(json.dumps(json.loads(sys.stdin.read()), indent=2))"

curl -s -X DELETE "http://127.0.0.1:3456/close?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}"
```
