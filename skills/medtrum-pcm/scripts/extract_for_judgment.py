#!/usr/bin/env python3
"""
Step 1: Extract items from raw JSON that need LLM judgment.
Outputs a simplified array for the agent to fill.
"""
import json, sys

raw = json.load(open(sys.argv[1]))
items = []
for i, item in enumerate(raw['items']):
    items.append({
        "index": i,
        "date": item.get('date',''),
        "author": item.get('authorName') or item.get('author') or '',
        "content": item.get('content','')[:500],  # truncated for reading
    })
json.dump(items, open(sys.argv[2], 'w'), ensure_ascii=False, indent=2)
print(f"Extracted {len(items)} items for judgment -> {sys.argv[2]}")
