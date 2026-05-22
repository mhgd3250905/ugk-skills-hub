# Step 11：HTML 邮件渲染（内联样式 + 分块校验 + 组装）

## 输入
- `output/*.json` — 所有平台的处理后 JSON
- `runtime/skills-user/medtrum-pcm/email-template.html` — HTML 外壳模板（纯内联样式，无 `<style>` 块）

## 任务

⚠️ **关键原则**：所有生成的 HTML 必须使用内联 `style=""` 属性，禁止使用 CSS class。邮件客户端（Gmail 等）会剥离 `<style>` 块和 `<head>` 中的样式，只保留内联样式。使用 `bgcolor` 属性替代 CSS background-color（兼容性更好）。

分 4 块逐步生成，每块产出后立即校验，通过才继续。

---

### Block A：数据汇总与校验

```bash
python3 << 'PYEOF'
import json, os, glob

items = []
platform_stats = {}
for f in glob.glob('output/linkedin-*.json') + glob.glob('output/tiktok-*.json') + glob.glob('output/instagram.json') + glob.glob('output/x-*.json') + glob.glob('output/reddit-*.json'):
    if '-raw' in f: continue
    if not os.path.exists(f): continue
    d = json.load(open(f))
    plat = d.get('platform','')
    kw = d.get('keyword','')
    for item in d.get('items',[]):
        item['_platform'] = plat
        item['_keyword'] = kw
        items.append(item)
    platform_stats[plat] = platform_stats.get(plat, 0) + d.get('total', 0)

total = len(items)
pos = sum(1 for i in items if i.get('sentiment')=='正向')
neg = sum(1 for i in items if i.get('sentiment')=='负向')
oth = total - pos - neg

def try_parse_date(raw):
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(raw or '').replace('Z','+00:00'))
    except:
        return None

dated = [i for i in items if try_parse_date(i.get('date_iso',''))]
undated = [i for i in items if not try_parse_date(i.get('date_iso',''))]
dated.sort(key=lambda i: try_parse_date(i.get('date_iso','')), reverse=True)
items_sorted = dated + undated

risks = [i for i in items if i.get('sentiment')=='负向']

data = {
    "total": total, "positive": pos, "negative": neg, "other": oth,
    "platforms": dict(sorted(platform_stats.items())),
    "risks_count": len(risks),
    "items": items_sorted,
    "risks": risks,
}
json.dump(data, open('/tmp/email-data.json','w'), ensure_ascii=False, indent=2)
print(f"Block A: {total} items, {pos} pos, {neg} neg, {oth} other, {len(risks)} risks")
PYEOF
```

**Block A 校验：**
```bash
python3 -c "
import json
d = json.load(open('/tmp/email-data.json'))
assert d['total'] > 0, 'no items'
assert d['total'] == d['positive'] + d['negative'] + d['other'], 'count mismatch'
assert len(d['risks']) == d['risks_count']
for item in d['items']:
    assert item.get('summary','').strip(), 'empty summary'
    assert item.get('relevant') in ('yes','uncertain'), f'invalid relevant: {item.get(\"relevant\")}'
    assert item.get('sentiment') in ('正向','负向','其他'), f'invalid sentiment: {item.get(\"sentiment\")}'
print(f'Block A PASS: {d[\"total\"]} items, {len(d[\"platforms\"])} platforms')
" && echo "✓ Block A" || echo "✗ Block A"
```

---

### Block B：报告上部（标题 + 摘要 + 各平台分析）

⚠️ **所有样式内联**：每个标签使用 `style="..."` 属性，表格用 `bgcolor`/`cellpadding`/`cellspacing`。不得出现 `class=`。

```bash
python3 << 'PYEOF'
import json
from datetime import datetime

d = json.load(open('/tmp/email-data.json'))
now = datetime.utcnow().strftime('%Y-%m-%d')
lines = []

# ═══ Report Title ═══
lines.append('<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border-bottom:3px solid #1a1a1a;">')
lines.append('<tr><td style="padding-bottom:16px;">')
lines.append(f'<h1 style="font-size:20px;font-weight:700;margin:0 0 6px 0;color:#1a1a1a;letter-spacing:0.3px;">每日 Medtrum 多平台多关键词舆情监测报告</h1>')
lines.append(f'<p style="color:#666;font-size:12px;margin:0;">报告日期：{now} &nbsp;|&nbsp; 关键词：touchcare、Medtrum &nbsp;|&nbsp; 范围：最近30天</p>')
lines.append('</td></tr></table>')

# ═══ Summary ═══
lines.append('<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">')
lines.append('<tr><td style="padding-bottom:10px;">')
lines.append('<span style="font-size:13px;font-weight:700;color:#1e3a5f;letter-spacing:1.5px;border-bottom:2px solid #1e3a5f;padding-bottom:6px;">摘要</span>')
lines.append('</td></tr>')
# Summary box with left accent border
lines.append('<tr><td>')
lines.append('<table width="100%" cellpadding="0" cellspacing="0"><tr>')
lines.append('<td width="4" bgcolor="#1e3a5f" style="font-size:0;line-height:0;">&nbsp;</td>')
lines.append('<td style="padding:14px 18px;background-color:#eef3f8;font-size:13px;">')
lines.append(f'本期共检索到 <b>{d["total"]}</b> 条相关舆情（<b style="color:#1a6b3c;">正向 {d["positive"]}</b> / <b style="color:#b91c1c;">负向 {d["negative"]}</b> / 其他 {d["other"]}）')
lines.append('</td></tr></table>')
lines.append('</td></tr></table>')

# ═══ Platform Summary Table ═══
lines.append('<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">')
lines.append('<tr><td style="padding-bottom:10px;">')
lines.append('<span style="font-size:13px;font-weight:700;color:#1e3a5f;letter-spacing:1.5px;border-bottom:2px solid #1e3a5f;padding-bottom:6px;">各平台舆情汇总</span>')
lines.append('</td></tr>')
lines.append('<tr><td>')

lines.append('<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;">')
lines.append('<tr>')
for h in ['平台','条目','正向','负向','其他']:
    lines.append(f'<th style="background-color:#1a1a1a;color:#fff;font-weight:600;padding:7px 10px;text-align:center;font-size:11px;">{h}</th>')
lines.append('</tr>')
for plat in ['LinkedIn','TikTok','Instagram','X','Reddit']:
    pi = [i for i in d['items'] if i['_platform'] == plat]
    p = sum(1 for i in pi if i.get('sentiment')=='正向')
    n = sum(1 for i in pi if i.get('sentiment')=='负向')
    o = len(pi) - p - n
    row_bg = '#fafafa' if ['LinkedIn','TikTok','Instagram','X','Reddit'].index(plat) % 2 == 0 else '#ffffff'
    if pi:
        lines.append(f'<tr><td style="padding:6px 10px;border:1px solid #d0d0d0;background-color:{row_bg};font-weight:600;">{plat}</td><td style="padding:6px 10px;border:1px solid #d0d0d0;background-color:{row_bg};text-align:center;">{len(pi)}</td><td style="padding:6px 10px;border:1px solid #d0d0d0;background-color:{row_bg};text-align:center;color:#1a6b3c;">{p}</td><td style="padding:6px 10px;border:1px solid #d0d0d0;background-color:{row_bg};text-align:center;color:#b91c1c;">{n}</td><td style="padding:6px 10px;border:1px solid #d0d0d0;background-color:{row_bg};text-align:center;">{o}</td></tr>')
    else:
        lines.append(f'<tr><td style="padding:6px 10px;border:1px solid #d0d0d0;background-color:{row_bg};font-weight:600;">{plat}</td><td colspan="4" style="padding:6px 10px;border:1px solid #d0d0d0;background-color:{row_bg};text-align:center;color:#999;font-style:italic;">-</td></tr>')
lines.append('</table>')
lines.append('</td></tr></table>')

# ═══ Platform Analysis ═══
lines.append('<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">')
lines.append('<tr><td style="padding-bottom:10px;">')
lines.append('<span style="font-size:13px;font-weight:700;color:#1e3a5f;letter-spacing:1.5px;border-bottom:2px solid #1e3a5f;padding-bottom:6px;">各平台分析</span>')
lines.append('</td></tr>')

def analyze_platform(pi, plat_name):
    if not pi:
        return f'<tr><td><table width="100%" cellpadding="0" cellspacing="0"><tr><td width="3" bgcolor="#1e3a5f"></td><td style="padding:14px 16px;border:1px solid #d0d0d0;background-color:#ffffff;"><h3 style="font-size:13px;font-weight:700;margin:0 0 6px 0;color:#1a1a1a;">{plat_name}</h3><p style="margin:0;color:#999;font-style:italic;">本轮无相关数据。</p></td></tr></table></td></tr>'
    
    summaries = [i.get('summary','') for i in pi]
    joined = ' '.join(summaries)
    p = sum(1 for i in pi if i.get('sentiment')=='正向')
    n = sum(1 for i in pi if i.get('sentiment')=='负向')
    o = len(pi) - p - n
    
    if n >= len(pi) * 0.3:
        sent = f'<span style="color:#b91c1c;font-weight:600;">负面舆情集中（{n}条）</span>，需重点关注'
        is_risk = True
    elif n > 0:
        sent = f'以正向为主（{p}条），发现{n}条负面需跟进'
        is_risk = False
    elif p >= len(pi) * 0.7:
        sent = f'全部正向或中性（{p}条），舆情健康'
        is_risk = False
    else:
        sent = f'以中性内容为主（{o}条）'
        is_risk = False
    
    # Topic clustering
    topics = []
    def count_topic(keywords):
        return sum(1 for s in summaries if any(k.lower() in s.lower() for k in keywords))
    
    if count_topic(['CITED','大会','展会','workshop','工作坊']):
        topics.append(('CITED糖尿病大会推广', count_topic(['CITED','大会','展会','workshop','工作坊']), False))
    if count_topic(['召回','recall','retirada','retiran','aemps','facua','FACUA','AEMPS']):
        topics.append(('A8 TouchCare召回事件', count_topic(['召回','recall','retirada','retiran','aemps','facua','FACUA','AEMPS']), True))
    if count_topic(['ANMAT','anmat']):
        topics.append(('ANMAT安全警告', count_topic(['ANMAT','anmat']), True))
    if count_topic(['Automeal','Auto Meal','auto meal']):
        topics.append(('Automeal功能讨论', count_topic(['Automeal','Auto Meal','auto meal']), False))
    if count_topic(['招聘','recrut','hiring','job']):
        topics.append(('招聘信息', count_topic(['招聘','recrut','hiring','job']), False))
    if count_topic(['马拉松','marathon','maraton']):
        topics.append(('用户运动故事', count_topic(['马拉松','marathon','maraton']), False))
    if count_topic(['临床','clinical','RCT','rct','住院','hospital','证据']):
        topics.append(('临床研究与证据', count_topic(['临床','clinical','RCT','rct','住院','hospital','证据']), False))
    if count_topic(['疼痛','pain','pijn','hurt','不适']):
        topics.append(('用户体验问题', count_topic(['疼痛','pain','pijn','hurt','不适']), True))
    if count_topic(['学术','educa','巴西','brasil','alianza','alliance']):
        if not any('CITED' in t[0] for t in topics):
            topics.append(('巴西Medtrum学术推广', count_topic(['学术','educa','巴西','brasil','alianza','alliance']), False))
    if count_topic(['法院','判决','justi','corte','decis','医保']):
        topics.append(('医保/法律相关', count_topic(['法院','判决','justi','corte','decis','医保']), False))
    if count_topic(['Cloud','cloud','EasyView','easyview','数据平台','云端']):
        topics.append(('EasyView云端平台', count_topic(['Cloud','cloud','EasyView','easyview','数据平台','云端']), False))
    if count_topic(['AID','人工胰腺','闭环','automated']):
        topics.append(('AID自动胰岛素输注', count_topic(['AID','人工胰腺','闭环','automated']), False))
    if count_topic(['贴片泵','patch pump','bomba','泵']):
        if not any(k in t[0] for t in topics for k in ['CITED','召回']):
            topics.append(('Medtrum贴片泵推广', count_topic(['贴片泵','patch pump','bomba','泵']), False))
    if count_topic(['CGM','cgm','传感器','sensor','血糖']):
        if not any(k in t[0] for t in topics for k in ['召回','ANMAT']):
            topics.append(('CGM/传感器相关', count_topic(['CGM','cgm','传感器','sensor','血糖']), False))
    if count_topic(['Team','团队','加入','入职','Marketing','marketing']):
        topics.append(('团队与营销动态', count_topic(['Team','团队','加入','入职','Marketing','marketing']), False))
    if count_topic(['经销商','distributor','假期','公告']):
        topics.append(('经销商公告', count_topic(['经销商','假期','公告']), False))
    if count_topic(['课程','class','讲座','训练','培训','course']):
        topics.append(('教育培训', count_topic(['课程','class','讲座','训练','培训','course']), False))
    
    covered = sum(t[1] for t in topics)
    uncovered = len(pi) - covered
    if uncovered > 0:
        topics.append(('其他内容', uncovered, False))
    
    # Top authors
    authors = {}
    for i in pi:
        a = (i.get('authorName','') or i.get('author','') or '').strip()
        if a and a.lower() != 'unknown' and a != '[unknown]': authors[a] = authors.get(a, 0) + 1
    top_authors = sorted(authors.items(), key=lambda x: -x[1])[:3]
    author_str = '、'.join(f'{a}（{c}条）' for a, c in top_authors) if top_authors else ''
    
    # Notable items
    seen_summaries = set()
    notable = []
    for i in pi:
        s = i.get('summary','')
        if s not in seen_summaries:
            seen_summaries.add(s)
            notable.append(i)
    notable.sort(key=lambda i: 0 if i.get('sentiment')=='负向' else 1)
    
    # Build card HTML
    border_color = '#b91c1c' if is_risk else '#1e3a5f'
    bg = '#fffbfb' if is_risk else '#ffffff'
    
    card = []
    card.append(f'<tr><td style="padding-bottom:8px;">')
    card.append(f'<table width="100%" cellpadding="0" cellspacing="0"><tr>')
    card.append(f'<td width="3" bgcolor="{border_color}" style="font-size:0;line-height:0;">&nbsp;</td>')
    card.append(f'<td style="padding:14px 16px;border:1px solid #d0d0d0;background-color:{bg};">')
    card.append(f'<h3 style="font-size:13px;font-weight:700;margin:0 0 6px 0;color:#1a1a1a;">{plat_name}</h3>')
    card.append(f'<p style="font-size:13px;margin:0 0 8px 0;">{sent}</p>')
    
    if topics:
        tags_html = ''
        for t_name, t_count, t_risk in topics:
            tag_bg = '#fee2e2' if t_risk else '#e4e8ec'
            tag_color = '#991b1b' if t_risk else '#333'
            tags_html += f'<span style="display:inline-block;background-color:{tag_bg};color:{tag_color};font-size:11px;font-weight:500;padding:2px 9px;margin:2px 5px 2px 0;">{t_name}（{t_count}条）</span>'
        card.append(f'<div style="margin-bottom:4px;">{tags_html}</div>')
    
    if author_str:
        card.append(f'<p style="font-size:11px;color:#666;margin:8px 0 0 0;">👤 {author_str}</p>')
    
    if notable:
        card.append(f'<div style="margin-top:8px;padding-top:8px;border-top:1px solid #e8e8e8;">')
        for ni in notable[:3]:
            flag = '⚠️ ' if ni.get('sentiment')=='负向' else ''
            card.append(f'<p style="font-size:12px;margin:3px 0;padding-left:10px;color:#444;">{flag}{ni.get("summary","")}</p>')
        card.append(f'</div>')
    
    card.append(f'</td></tr></table>')
    card.append(f'</td></tr>')
    return '\n'.join(card)

lines.append('<tr><td>')
for plat in ['LinkedIn','TikTok','Instagram','X','Reddit']:
    pi = [i for i in d['items'] if i['_platform'] == plat]
    lines.append(analyze_platform(pi, plat))
lines.append('</td></tr></table>')

with open('/tmp/email-header.html','w') as f: f.write('\n'.join(lines))
print(f"Block B: {len(lines)} lines")
PYEOF
```

**Block B 校验：**
```bash
python3 -c "
import json
d = json.load(open('/tmp/email-data.json'))
with open('/tmp/email-header.html') as f: h = f.read()
for check in ['<h1', '报告日期', 'touchcare', 'Medtrum', '各平台舆情汇总', '各平台分析', '<table']:
    assert check in h, f'Missing: {check}'
if d['risks_count'] > 0:
    assert '重点风险事件' in h or '负面' in h, 'Risk section missing'
else:
    assert '未发现明确负向风险' in h or '正向' in h, 'No-risk message missing'
for plat in ['LinkedIn','TikTok','Instagram','X','Reddit']:
    assert plat in h, f'Platform missing: {plat}'
# Must NOT contain template-level tags
assert '<html>' not in h and '<body>' not in h and '<style>' not in h, 'Block B contains template-level tags'
# Must NOT contain CSS classes
import re
classes = re.findall(r'class=\"', h)
assert len(classes) == 0, f'Block B contains {len(classes)} CSS class references'
print('Block B PASS')
" && echo "✓ Block B" || echo "✗ Block B"
```

---

### Block C：平台详情表格

按平台分组，各平台内按时间倒序，每平台一个表格。所有样式内联，使用 `bgcolor` 属性。

```bash
python3 << 'PYEOF'
import json

d = json.load(open('/tmp/email-data.json'))

def try_parse(raw):
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(raw or '').replace('Z','+00:00'))
    except:
        return None

reordered = []
for plat in ['LinkedIn','TikTok','Instagram','X','Reddit']:
    pi = [i for i in d['items'] if i['_platform'] == plat]
    dated = [i for i in pi if try_parse(i.get('date_iso',''))]
    undated = [i for i in pi if not try_parse(i.get('date_iso',''))]
    dated.sort(key=lambda i: try_parse(i.get('date_iso','')), reverse=True)
    reordered.extend(dated + undated)
d['items'] = reordered
json.dump(d, open('/tmp/email-data.json','w'), ensure_ascii=False, indent=2)

lines = []
lines.append('<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">')
lines.append('<tr><td style="padding-bottom:10px;">')
lines.append('<span style="font-size:13px;font-weight:700;color:#1e3a5f;letter-spacing:1.5px;border-bottom:2px solid #1e3a5f;padding-bottom:6px;">舆情记录明细</span>')
lines.append('</td></tr>')

for plat in ['LinkedIn','TikTok','Instagram','X','Reddit']:
    pi = [i for i in d['items'] if i['_platform'] == plat]
    if not pi:
        lines.append(f'<tr><td style="padding:8px 0;">')
        lines.append(f'<h3 style="font-size:13px;font-weight:700;margin:16px 0 6px 0;padding:6px 10px;background-color:#f4f6f8;">{plat}</h3>')
        lines.append(f'<p style="color:#999;font-style:italic;margin:0;">本轮无相关数据</p>')
        lines.append(f'</td></tr>')
        continue
    
    lines.append(f'<tr><td style="padding:8px 0;">')
    lines.append(f'<h3 style="font-size:13px;font-weight:700;margin:16px 0 6px 0;padding:6px 10px;background-color:#f4f6f8;">{plat}（{len(pi)}条）</h3>')
    
    lines.append('<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;">')
    lines.append('<tr>')
    for h in ['日期','发帖人','内容说明','情感']:
        lines.append(f'<th style="background-color:#1a1a1a;color:#fff;font-weight:600;padding:6px 8px;text-align:left;font-size:11px;">{h}</th>')
    lines.append('</tr>')
    
    for idx, item in enumerate(pi):
        is_risk = item.get('sentiment')=='负向'
        is_unc = item.get('relevant')=='uncertain'
        date = (item.get('date','') or '?')[:16]
        author = (item.get('authorName','') or item.get('author','') or '?')[:25]
        summary = (item.get('summary','') or '?')
        url = item.get('url','')
        sentiment = item.get('sentiment','?')
        
        if is_risk:
            row_bg = '#fef2f2'
        elif is_unc:
            row_bg = '#fffbeb'
        else:
            row_bg = '#ffffff' if idx % 2 == 0 else '#fafafa'
        
        if sentiment == '正向':
            sent_color = '#1a6b3c'
        elif sentiment == '负向':
            sent_color = '#b91c1c'
        else:
            sent_color = '#b45309' if is_unc else '#666'
        
        flag = '⚠️ ' if is_risk else ('❓ ' if is_unc else '')
        link_html = f' <a href="{url}" style="color:#1e3a5f;text-decoration:none;">🔗</a>' if url else ''
        
        lines.append(f'<tr>')
        lines.append(f'<td style="padding:6px 8px;border:1px solid #d0d0d0;background-color:{row_bg};font-size:12px;">{date}</td>')
        lines.append(f'<td style="padding:6px 8px;border:1px solid #d0d0d0;background-color:{row_bg};font-size:12px;">{author}</td>')
        lines.append(f'<td style="padding:6px 8px;border:1px solid #d0d0d0;background-color:{row_bg};font-size:13px;">{flag}{summary}{link_html}</td>')
        lines.append(f'<td style="padding:6px 8px;border:1px solid #d0d0d0;background-color:{row_bg};text-align:center;font-size:12px;color:{sent_color};font-weight:600;">{sentiment}</td>')
        lines.append(f'</tr>')
    
    lines.append('</table>')
    lines.append('</td></tr>')

lines.append('</table>')

with open('/tmp/email-detail.html','w') as f: f.write('\n'.join(lines))
print(f"Block C: {len(lines)} lines")
PYEOF
```

**Block C 校验：**
```bash
python3 -c "
import json, re
d = json.load(open('/tmp/email-data.json'))
with open('/tmp/email-detail.html') as f: h = f.read()
for plat in ['LinkedIn','TikTok','Instagram','X','Reddit']:
    assert plat in h, f'Platform missing in detail: {plat}'
for plat in ['LinkedIn','TikTok','Instagram','X','Reddit']:
    pi = [i for i in d['items'] if i['_platform'] == plat]
    if pi:
        assert f'{plat}（{len(pi)}条）' in h, f'Header mismatch: {plat}'
assert '<html>' not in h and '<body>' not in h, 'Block C contains template-level tags'
classes = re.findall(r'class=\"', h)
assert len(classes) == 0, f'Block C contains {len(classes)} CSS class references'
print('Block C PASS')
" && echo "✓ Block C" || echo "✗ Block C"
```

---

### Block D：结尾 + 模板组装

```bash
python3 << 'PYEOF'
with open('runtime/skills-user/medtrum-pcm/email-template.html') as f:
    template = f.read()

with open('/tmp/email-header.html') as f: header = f.read()
with open('/tmp/email-detail.html') as f: detail = f.read()

footer_lines = []
footer_lines.append('<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;border-top:2px solid #d0d0d0;">')
footer_lines.append('<tr><td style="padding:14px 18px;background-color:#f0f0f0;font-size:11px;color:#666;">')
footer_lines.append('<p style="margin:4px 0;"><b style="color:#555;">结论与建议：</b>整体舆情以正向和中性为主。建议重点关注负向事件进展，及时准备应对方案。</p>')
footer_lines.append('<p style="margin:4px 0;"><b style="color:#555;">局限性：</b></p>')
footer_lines.append('<ul style="padding-left:18px;margin:4px 0;">')
footer_lines.append('<li>检索仅覆盖 LinkedIn、TikTok、Instagram、X、Reddit 五个平台</li>')
footer_lines.append('<li>Instagram 处于算法训练阶段，内容覆盖不完整</li>')
footer_lines.append('<li>LLM 判断存在一定误判率，建议人工复核重点风险条目</li>')
footer_lines.append('</ul>')
footer_lines.append('<p style="margin:4px 0;">本报告由自动化系统生成，如有疑问请联系管理员。</p>')
footer_lines.append('</td></tr></table>')
footer = '\n'.join(footer_lines)

html = template.replace('{{HEADER}}', header)
html = html.replace('{{DETAIL}}', detail)
html = html.replace('{{FOOTER}}', footer)

with open('output/final-report-email.html','w') as f: f.write(html)
print(f"Block D: assembled, {len(html)} chars")
PYEOF
```

**Block D 校验（最终组装校验）：**
```bash
python3 << 'PYEOF'
import json, re

d = json.load(open('/tmp/email-data.json'))
with open('output/final-report-email.html') as f: html = f.read()

assert len(html) > 1000, 'HTML too short'
assert '<!DOCTYPE html>' in html, 'Missing DOCTYPE'
assert '<html ' in html and '</html>' in html, 'Missing html tags'
assert '<body' in html and '</body>' in html, 'Missing body tags'

# Content integrity
assert '每日 Medtrum' in html, 'Missing title'
assert 'touchcare' in html and 'Medtrum' in html, 'Missing keywords'
assert '各平台舆情汇总' in html, 'Missing summary table'
assert '各平台分析' in html, 'Missing platform analysis'
assert '舆情记录明细' in html, 'Missing detail section'
assert '结论与建议' in html, 'Missing conclusion'
assert '局限性' in html, 'Missing limitations'

# No placeholder leakage
assert '{{HEADER}}' not in html, 'HEADER placeholder not replaced'
assert '{{DETAIL}}' not in html, 'DETAIL placeholder not replaced'
assert '{{FOOTER}}' not in html, 'FOOTER placeholder not replaced'

# No CSS class leakage
classes = re.findall(r'class="', html)
assert len(classes) == 0, f'{len(classes)} CSS class references found (email-incompatible)'

# Platform counts
for plat in ['LinkedIn','TikTok','Instagram','X','Reddit']:
    pi = [i for i in d['items'] if i['_platform'] == plat]
    if pi:
        assert f'{plat}（{len(pi)}条）' in html, f'Count mismatch: {plat}'

# No broken links
hrefs = re.findall(r'<a href="([^"]*)"', html)
empty_hrefs = [h for h in hrefs if not h.strip()]
assert len(empty_hrefs) == 0, f'{len(empty_hrefs)} empty hrefs found'

# Sentiment: negative items must have red background color in detail table
neg_items = [i for i in d['items'] if i.get('sentiment')=='负向']
neg_bg_count = html.count('background-color:#fef2f2')
# Each negative row has 4 cells with this bg color
assert neg_bg_count >= len(neg_items) * 4, f'Expected >= {len(neg_items)*4} negative cells, found {neg_bg_count}'

print(f'Block D PASS: {len(html)} chars, {len(hrefs)} links')
PYEOF
```

---

## 输出
`output/final-report-email.html`

## 验证命令（快速总检）
```bash
python3 -c "
with open('output/final-report-email.html') as f: html = f.read()
assert len(html) > 1000
assert '<!DOCTYPE html>' in html
assert '<table>' in html
assert '每日 Medtrum' in html
assert '各平台舆情汇总' in html
assert '各平台分析' in html
assert '舆情记录明细' in html
assert '结论与建议' in html
# No CSS classes (email safe check)
import re
assert len(re.findall(r'class=\"', html)) == 0, 'CSS classes found!'
print('PASS: step-11')
" && echo "✓ Step 11 complete"
```

## 验证失败处理
- Block A 失败：检查 JSON 完整性，重试最多 1 次
- Block B/C 失败：重试对应 Block 最多 1 次
- Block D 失败：检查前 3 块文件是否存在，重试组装最多 1 次
- 最终失败：标记 `HTML 渲染失败`，终止流水线

## 下一步
`plans/step-12-email-send.md`
