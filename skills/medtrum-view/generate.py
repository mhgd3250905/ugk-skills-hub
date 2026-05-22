#!/usr/bin/env python3
"""
Generate static HTML view from shared SQLite database.
Output: /app/public/medtrum-view/index.html (fixed path, accessible via v1/local-file)
"""

import json
import os
import sqlite3

DB_PATH = "/app/.data/agent/background/medtrum-spider/medtrum.db"
# 按 medtrum-view 技能规范：写入 ARTIFACT_PUBLIC_DIR，URL 用 ARTIFACT_PUBLIC_BASE_URL
_ARTIFACT_DIR = os.environ.get("ARTIFACT_PUBLIC_DIR", "/app/public")
_ARTIFACT_URL = os.environ.get("ARTIFACT_PUBLIC_BASE_URL", "")
OUT_DIR = os.path.join(_ARTIFACT_DIR, "medtrum-view")
OUT_FILE = os.path.join(OUT_DIR, "index.html")


def get_data():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT platform, keyword, date_raw, date_iso, author_name,
               summary, sentiment, relevant, url, content, ingested_at
        FROM items
        ORDER BY date_iso DESC NULLS LAST, ingested_at DESC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def build_platform_pills(platforms):
    parts = ['<span class="pill active" onclick="filterPlatform(\'all\')">全部</span>']
    for p in platforms:
        parts.append(f'<span class="pill" onclick="filterPlatform(\'{p}\')">{p}</span>')
    return "".join(parts)


def build_sentiment_pills(sentiments):
    parts = ['<span class="pill active" onclick="filterSentiment(\'all\')">全部</span>']
    for s in sentiments:
        sc = "neg" if s == "负向" else ("pos" if s == "正向" else "")
        parts.append(f'<span class="pill {sc}" onclick="filterSentiment(\'{s}\')">{s}</span>')
    return "".join(parts)


def build_stat_cards(total, pos_count, neg_count, oth_count, plat_counts, platforms):
    cards = []
    cards.append(f'<div class="stat-card"><div class="num">{total}</div><div class="lbl">总条目</div></div>')
    cards.append(f'<div class="stat-card pos"><div class="num">{pos_count}</div><div class="lbl">正向</div></div>')
    cards.append(f'<div class="stat-card neg"><div class="num">{neg_count}</div><div class="lbl">负向</div></div>')
    cards.append(f'<div class="stat-card"><div class="num">{oth_count}</div><div class="lbl">其他</div></div>')
    for p in platforms:
        cards.append(f'<div class="stat-card"><div class="num">{plat_counts[p]}</div><div class="lbl">{p}</div></div>')
    return "".join(cards)


def build_html(items):
    total = len(items)
    platforms = sorted(set(i["platform"] for i in items if i["platform"]))
    sentiments = sorted(set(i["sentiment"] for i in items if i["sentiment"]), reverse=True)

    pos_count = sum(1 for i in items if i["sentiment"] == "正向")
    neg_count = sum(1 for i in items if i["sentiment"] == "负向")
    oth_count = total - pos_count - neg_count

    plat_counts = {p: sum(1 for i in items if i["platform"] == p) for p in platforms}

    items_json = json.dumps(items, ensure_ascii=False)

    HEAD = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Medtrum 多平台舆情监控</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:'PingFang SC','Microsoft YaHei',sans-serif; background:#f0f2f5; color:#1a1a1a; font-size:13px; }
.header { background:#1e3a5f; color:#fff; padding:20px 24px; }
.header h1 { font-size:18px; margin-bottom:6px; }
.header .sub { font-size:12px; opacity:0.8; }

.stats { display:flex; gap:12px; padding:16px 24px; background:#fff; border-bottom:1px solid #e0e0e0; flex-wrap:wrap; }
.stat-card { background:#f8f9fa; padding:10px 18px; border-radius:4px; text-align:center; min-width:80px; }
.stat-card .num { font-size:22px; font-weight:700; }
.stat-card .lbl { font-size:11px; color:#666; }
.stat-card.pos .num { color:#1a6b3c; }
.stat-card.neg .num { color:#b91c1c; }

.filters { display:flex; gap:8px; padding:12px 24px; background:#fff; border-bottom:1px solid #e0e0e0; flex-wrap:wrap; align-items:center; }
.filters input { padding:6px 12px; border:1px solid #d0d0d0; border-radius:4px; font-size:12px; width:180px; outline:none; }
.filters input:focus { border-color:#1e3a5f; }
.pill { padding:4px 12px; border-radius:14px; font-size:11px; cursor:pointer; border:1px solid #d0d0d0; background:#fff; transition:all 0.15s; user-select:none; }
.pill:hover { border-color:#1e3a5f; }
.pill.active { background:#1e3a5f; color:#fff; border-color:#1e3a5f; }
.pill.neg.active { background:#b91c1c; border-color:#b91c1c; }
.pill.pos.active { background:#1a6b3c; border-color:#1a6b3c; }

.table-wrap { margin:16px 24px; background:#fff; border:1px solid #e0e0e0; border-radius:4px; overflow:hidden; }
table { width:100%; border-collapse:collapse; }
th { background:#1a1a1a; color:#fff; font-weight:600; padding:8px 10px; text-align:left; font-size:11px; white-space:nowrap; }
td { padding:8px 10px; border-bottom:1px solid #f0f0f0; vertical-align:top; }
tr:hover td { background:#f8f9ff; }
.row-neg td { background:#fef2f2; }
.row-neg:hover td { background:#fee2e2; }
.row-unc td { background:#fffbeb; }

.platform-tag { display:inline-block; padding:1px 8px; border-radius:10px; font-size:10px; font-weight:600; background:#e4e8ec; color:#555; }
.sentiment-tag { display:inline-block; padding:1px 8px; border-radius:10px; font-size:10px; font-weight:600; }
.sent-pos { background:#d4edda; color:#1a6b3c; }
.sent-neg { background:#f8d7da; color:#b91c1c; }
.sent-oth { background:#e2e3e5; color:#555; }

.summary-td { max-width:420px; word-break:break-word; }
a { color:#1e3a5f; text-decoration:none; }
a:hover { text-decoration:underline; }

.hidden { display:none; }
.no-results { text-align:center; padding:40px; color:#999; font-size:14px; }

.footer { padding:16px 24px; text-align:center; color:#999; font-size:11px; }

.btn-download { display:inline-block; padding:8px 18px; background:#1a6b3c; color:#fff; text-decoration:none; border-radius:4px; font-size:13px; font-weight:600; white-space:nowrap; transition:background 0.15s; }
.btn-download:hover { background:#145a30; text-decoration:none; }

/* Mobile / Desktop toggle */
.mobile-only { display:none; }
.desktop-only { display:block; }
@media (max-width:768px) {
  .mobile-only { display:block; }
  .desktop-only { display:none; }
}
"""

    css_mobile = """@media (max-width:768px) {
  .header { padding:14px 16px; }
  .header h1 { font-size:15px; }
  .header .sub { font-size:10px; }

  .stats { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; padding:10px 12px; }
  .stat-card { padding:8px 6px; min-width:0; }
  .stat-card .num { font-size:18px; }
  .stat-card .lbl { font-size:10px; }

  .filters { padding:10px 12px; gap:6px; overflow-x:auto; white-space:nowrap; -webkit-overflow-scrolling:touch; flex-wrap:nowrap; }
  .filters input { width:130px; flex-shrink:0; }
  .pill { font-size:10px; padding:3px 10px; flex-shrink:0; }

  .table-wrap { margin:8px; }
  .table-wrap table.desktop-only { display:none; }

  /* Card layout */
  .card-list { display:flex; flex-direction:column; gap:8px; }
  .card { background:#fff; border:1px solid #e0e0e0; border-radius:6px; padding:12px; }
  .card.risk { border-left:3px solid #b91c1c; background:#fef2f2; }
  .card.uncertain { border-left:3px solid #f59e0b; background:#fffbeb; }
  .card .card-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }
  .card .card-date { font-size:11px; color:#666; }
  .card .card-tags { display:flex; gap:4px; }
  .card .card-summary { font-size:13px; line-height:1.5; margin-bottom:4px; }
  .card .card-author { font-size:11px; color:#888; }
  .card .card-link { font-size:12px; margin-top:4px; }
}
</style>
</head>
<body>
"""

    # 读取最新 PDF 文件名
    _pdf_marker = os.path.join(OUT_DIR, ".pdf-latest.txt")
    _pdf_name = "medtrum-report.pdf"
    if os.path.exists(_pdf_marker):
        _n = open(_pdf_marker).read().strip()
        if _n:
            _pdf_name = _n
    _pdf_url = f"{_ARTIFACT_URL}/medtrum-view/{_pdf_name}" if _ARTIFACT_URL else f"/v1/local-file?path={OUT_DIR}/{_pdf_name}"

    header_html = f"""<div class="header">
  <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
    <div>
      <h1>📊 Medtrum 多平台舆情监控</h1>
      <div class="sub">数据来源：LinkedIn · TikTok · Instagram · X · Reddit | 关键词：touchcare / Medtrum</div>
    </div>
    <a href="{_pdf_url}" class="btn-download" download="{_pdf_name}">📥 导出报告 PDF</a>
  </div>
</div>
"""

    stats_html = f'<div class="stats">{build_stat_cards(total, pos_count, neg_count, oth_count, plat_counts, platforms)}</div>\n'

    pills_html = f"""<div class="filters">
  <span style="font-weight:600;font-size:11px;color:#666;">平台：</span>
  {build_platform_pills(platforms)}
  <span style="margin-left:16px;font-weight:600;font-size:11px;color:#666;">情感：</span>
  {build_sentiment_pills(sentiments)}
  <input type="text" placeholder="🔍 搜索内容/摘要/作者..." oninput="filterSearch(this.value)" style="margin-left:16px;">
</div>
"""

    table_head = """<div class="table-wrap">
  <table class="desktop-only">
    <thead>
      <tr>
        <th style="width:100px">日期</th>
        <th style="width:60px">平台</th>
        <th style="width:60px">情感</th>
        <th>摘要</th>
        <th style="width:100px">作者</th>
        <th style="width:40px">链接</th>
      </tr>
    </thead>
    <tbody id="item-body">
    </tbody>
  </table>
  <div class="card-list mobile-only" id="card-list">
  </div>
  <div class="no-results hidden" id="no-results">没有匹配的结果</div>
</div>
"""

    footer_html = '<div class="footer">数据更新时间：<span id="update-time"></span> | 由 Medtrum Spider 自动采集</div>\n'

    js_template = r"""
<script>
var DATA = %s;

function render(items) {
  var tbody = document.getElementById('item-body');
  var cardList = document.getElementById('card-list');
  var noRes = document.getElementById('no-results');
  tbody.innerHTML = '';
  if (cardList) cardList.innerHTML = '';

  if (items.length === 0) {
    noRes.classList.remove('hidden');
    return;
  }
  noRes.classList.add('hidden');

  var sentClass = {'正向':'sent-pos','负向':'sent-neg'};
  var sentDef = 'sent-oth';

  items.forEach(function(i) {
    var date = i.date_iso ? i.date_iso.substring(0,16) : (i.date_raw || '?');
    var rowClass = i.sentiment === '负向' ? 'row-neg' : (i.relevant === 'uncertain' ? 'row-unc' : '');
    var stClass = sentClass[i.sentiment] || sentDef;
    var urlLink = i.url ? '<a href="' + i.url + '" target="_blank">🔗</a>' : '';
    var author = (i.author_name || '?').substring(0,20);

    // Desktop table row
    var tr = document.createElement('tr');
    if (rowClass) tr.className = rowClass;
    tr.innerHTML =
      '<td style="font-size:11px;white-space:nowrap;">' + date + '</td>' +
      '<td><span class="platform-tag">' + (i.platform || '?') + '</span></td>' +
      '<td><span class="sentiment-tag ' + stClass + '">' + (i.sentiment || '?') + '</span></td>' +
      '<td class="summary-td">' + (i.summary || '?') + '</td>' +
      '<td style="font-size:11px;color:#666;">' + author + '</td>' +
      '<td>' + urlLink + '</td>';
    tbody.appendChild(tr);

    // Mobile card
    if (cardList) {
      var card = document.createElement('div');
      var cardClass = i.sentiment === '负向' ? 'card risk' : (i.relevant === 'uncertain' ? 'card uncertain' : 'card');
      card.className = cardClass;
      card.innerHTML =
        '<div class="card-header">' +
          '<span class="card-date">' + date + '</span>' +
          '<span class="card-tags">' +
            '<span class="platform-tag">' + (i.platform || '?') + '</span>' +
            '<span class="sentiment-tag ' + stClass + '">' + (i.sentiment || '?') + '</span>' +
          '</span>' +
        '</div>' +
        '<div class="card-summary">' + (i.summary || '?') + '</div>' +
        '<div class="card-author">' + author + '</div>' +
        '<div class="card-link">' + urlLink + '</div>';
      cardList.appendChild(card);
    }
  });
}

var currentPlat = 'all';
var currentSent = 'all';
var currentSearch = '';

function doFilter() {
  var items = DATA;
  if (currentPlat !== 'all') items = items.filter(function(i) { return i.platform === currentPlat; });
  if (currentSent !== 'all') items = items.filter(function(i) { return i.sentiment === currentSent; });
  if (currentSearch) {
    var q = currentSearch.toLowerCase();
    items = items.filter(function(i) {
      return (i.summary||'').toLowerCase().indexOf(q) >= 0 ||
             (i.author_name||'').toLowerCase().indexOf(q) >= 0 ||
             (i.content||'').toLowerCase().indexOf(q) >= 0;
    });
  }
  render(items);
}

function setActivePills(selector, value) {
  var pills = document.querySelectorAll(selector);
  pills.forEach(function(p) {
    if (p.textContent === value || (value === 'all' && p.textContent === '全部')) {
      p.classList.add('active');
    } else {
      p.classList.remove('active');
    }
  });
}

function filterPlatform(plat) {
  currentPlat = plat;
  setActivePills('.filters .pill:not(.pos):not(.neg)', plat);
  doFilter();
}

function filterSentiment(sent) {
  currentSent = sent;
  doFilter();
}

function filterSearch(q) {
  currentSearch = q;
  doFilter();
}

render(DATA);
document.getElementById('update-time').textContent = new Date().toLocaleString('zh-CN');
</script>
</body>
</html>
"""

    return (HEAD + css_mobile + header_html + stats_html + pills_html +
            table_head + footer_html + (js_template % items_json))


def main():
    items = get_data()
    os.makedirs(OUT_DIR, exist_ok=True)
    html = build_html(items)
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"Generated {OUT_FILE} ({len(html)} chars, {len(items)} items)")
    if _ARTIFACT_URL:
        print(f"View URL: {_ARTIFACT_URL}/medtrum-view/index.html")
    else:
        print(f"View URL: /v1/local-file?path={OUT_FILE}")


if __name__ == "__main__":
    main()
