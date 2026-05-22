#!/usr/bin/env python3
"""Process raw LinkedIn JSON: copy items with judgment placeholders, ready for agent to fill."""
import json, sys

def main(raw_path, out_path):
    raw = json.load(open(raw_path))
    items = []
    for i, item in enumerate(raw['items']):
        items.append({
            **item,  # copy all original fields unchanged
            "relevant": "TO_FILL",
            "summary": "TO_FILL",
            "sentiment": "TO_FILL",
        })
    
    out = {
        "platform": raw['platform'],
        "keyword": raw['keyword'],
        "retrievedAt": raw['retrievedAt'],
        "total": len(items),
        "items": items,
    }
    json.dump(out, open(out_path, 'w'), ensure_ascii=False, indent=2)
    print(f"Wrote {len(items)} items to {out_path}")

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
