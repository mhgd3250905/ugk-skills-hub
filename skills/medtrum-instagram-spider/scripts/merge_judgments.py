#!/usr/bin/env python3
"""
Step 2: Merge agent judgments back into raw JSON.
judgments.json format: [{"index":0, "relevant":"yes", "summary":"...", "sentiment":"正向", "date_iso":"2026-05-06 14:30"}, ...]
Only items with relevant != "no" are kept.
Original fields (date, authorName, authorHandle, content, url) are read from raw JSON only.
Agent's judgments CANNOT modify these fields - they come from raw.
date_iso is the only new field carried from judgment to output.
"""
import json, sys

raw = json.load(open(sys.argv[1]))
judgments = json.load(open(sys.argv[2]))

# Build index lookup
judge_map = {j['index']: j for j in judgments}

items = []
for i, item in enumerate(raw['items']):
    j = judge_map.get(i)
    if not j or j.get('relevant') == 'no':
        continue
    items.append({
        **raw['items'][i],  # copy all original fields unchanged
        "relevant": j['relevant'],
        "summary": j['summary'],
        "sentiment": j['sentiment'],
        "date_iso": j.get('date_iso', ''),  # agent-converted timestamp
    })

out = {
    "platform": raw['platform'],
    "keyword": raw['keyword'],
    "retrievedAt": raw['retrievedAt'],
    "total": len(items),
    "items": items,
}
json.dump(out, open(sys.argv[3], 'w'), ensure_ascii=False, indent=2)
print(f"Merged {len(items)} items -> {sys.argv[3]}")
