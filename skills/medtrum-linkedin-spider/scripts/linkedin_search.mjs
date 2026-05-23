#!/usr/bin/env node
// @version 2026-05-23-v6 — linkedin_search spider
// Architecture:
//   Phase 1 (Browser CDP): collectRawCards — pure DOM scraper, zero parsing.
//   Phase 2 (Node.js): processCards — parses, deduplicates, filters by time.
//   Bottom detection: bounce + stall counter (MAX_BOTTOM_STALL=3).
//     Handles LinkedIn's persistent loading indicators at page bottom.
//   Sibling time: multi-level ancestor walk via parentElement.children
//     (not flat previousElementSibling) to reach shared-post time labels.
//   All CDP expressions use toExpression() — avoids template-literal
//     serialization issues in CDP Runtime.evaluate.

import fs from 'node:fs';
import process from 'node:process';

import {
  buildLinkedInSearchUrl,
  buildSearchResultJson,
} from './linkedin_search_lib.mjs';
import {
  ensureHostBrowserBridge,
  requestHostBrowser,
} from '../../web-access/scripts/host-bridge.mjs';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function toExpression(factory, ...args) {
  return '(' + factory.toString() + ')(' + args.map(function (a) { return JSON.stringify(a); }).join(',') + ')';
}

function parseArgs(argv) {
  var args = { keyword: '', days: 30, maxScrolls: 50, maxResults: 100, dryRun: false, debugDump: '' };
  for (var i = 0; i < argv.length; i += 1) {
    var t = argv[i];
    if (t === '--keyword') { args.keyword = String(argv[i + 1] || ''); i += 1; continue; }
    if (t === '--days') { args.days = Number(argv[i + 1] || '30'); i += 1; continue; }
    if (t === '--max-scrolls') { args.maxScrolls = Number(argv[i + 1] || '3'); i += 1; continue; }
    if (t === '--max-results') { args.maxResults = Number(argv[i + 1] || '12'); i += 1; continue; }
    if (t === '--dry-run') { args.dryRun = true; continue; }
    if (t === '--debug-dump') { args.debugDump = String(argv[i + 1] || ''); i += 1; }
  }
  if (!args.keyword.trim()) throw new Error('keyword required');
  if (!Number.isInteger(args.days) || args.days <= 0) throw new Error('days must be positive integer');
  return args;
}

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

async function evaluate(targetId, expression) {
  var result = await requestHostBrowser(
    { action: 'evaluate', targetId: targetId, expression: expression },
    { timeoutMs: 45000 },
  );
  if (!result || !result.ok) {
    throw new Error((result && result.error) || 'evaluate_failed');
  }
  return result.value;
}

async function createTarget(url) {
  var result = await requestHostBrowser(
    { action: 'new_target', url: url },
    { timeoutMs: 15000 },
  );
  if (!result || !result.ok || !result.target || !result.target.id) {
    throw new Error('create_target_failed');
  }
  return result.target.id;
}

async function closeTarget(targetId) {
  await requestHostBrowser(
    { action: 'close_target', targetId: targetId },
    { timeoutMs: 5000 },
  ).catch(function () {});
}

// ---------------------------------------------------------------------------
// Phase 1 (Browser CDP): Pure DOM scraper
// ---------------------------------------------------------------------------

function collectRawCards(limit) {
  var norm = function (v) { return String(v || '').replace(/\s+/g, ' ').trim(); };

  var pickContainer = function (anchor) {
    var node = anchor;
    var fb = anchor.parentElement || anchor;
    for (var d = 0; d < 10 && node; d += 1) {
      var t = norm(node.innerText || node.textContent || '');
      if (t.length >= 40) fb = node;
      if (t.length >= 160 && t.length <= 3000) {
        // Climb to the outermost card wrapper that still looks like
        // a single card (stops before the full feed container).
        var upper = node;
        for (var u = 0; u < 6 && upper; u += 1) {
          var p = upper.parentElement;
          if (!p) break;
          var pt = norm(p.innerText || p.textContent || '');
          if (pt.length > t.length && pt.length <= 12000) {
            upper = p;
            t = pt;
          } else {
            break;
          }
        }
        return upper;
      }
      node = node.parentElement;
    }
    return fb;
  };

  if (location.pathname.indexOf('/login') >= 0) {
    return { loginRequired: true, cards: [], failed: [], stillLoading: false };
  }

  var cardSet = new Set();
  var candidates = [];
  var anchors = document.querySelectorAll('a[href*="/in/"], a[href*="/company/"]');
  for (var ai = 0; ai < anchors.length; ai += 1) {
    var c = pickContainer(anchors[ai]);
    if (!c || cardSet.has(c)) continue;
    cardSet.add(c);
    candidates.push(c);
  }

  var cards = [];
  var seen = new Set();
  var failed = [];

  for (var ci = 0; ci < candidates.length; ci += 1) {
    try {
      var container = candidates[ci];
      var text = norm(container.innerText || container.textContent || '');
      if (!text || text.length < 80) continue;

      var sourceEl = container;

      // Safety net: scan for ::after pseudo-element time labels.
      var afterTimes = [];
      try {
        var scanRoots = [sourceEl];
        if (sourceEl.parentElement) scanRoots.push(sourceEl.parentElement);
        for (var si = 0; si < scanRoots.length && afterTimes.length < 2; si += 1) {
          var scanEls = scanRoots[si].querySelectorAll('*');
          for (var ei = 0; ei < scanEls.length && ei < 80 && afterTimes.length < 2; ei += 1) {
            try {
              var ac = getComputedStyle(scanEls[ei], '::after').getPropertyValue('content');
              if (ac && ac !== 'none' && ac !== 'normal' && ac !== '""') {
                var cleaned = ac.replace(/^["']|["']$/g, '').trim();
                if (cleaned && cleaned.length >= 2 && /\d/.test(cleaned)) {
                  afterTimes.push(cleaned);
                }
              }
            } catch (_cssErr) {}
          }
        }
      } catch (_scanErr) {}
      if (afterTimes.length > 0) {
        text = text + ' | ' + afterTimes.join(' | ');
      }

      var links = sourceEl.querySelectorAll('a[href]');
      // Fast path: flat previousElementSibling chain.
      var siblingLinks = [];
      var prevTexts = [];
      var prevTotalChars = 0;
      var sib = sourceEl.previousElementSibling;
      while (sib) {
        var st = norm(sib.innerText || sib.textContent || '');
        if (st.length > 2000) break;
        var sa = sib.querySelectorAll('a[href]');
        for (var sj = 0; sj < sa.length; sj += 1) siblingLinks.push(sa[sj]);
        prevTexts.push(st);
        prevTotalChars += st.length;
        if (prevTotalChars > 3000) break;
        sib = sib.previousElementSibling;
      }
      // Short shared-post fallback: walk ancestors when sourceEl is in
      // a wrapper whose only sibling is another wrapper with header-time.
      if (prevTexts.length === 0 && text.length < 500) {
        for (var w = sourceEl, lv = 0; lv < 4 && w; lv += 1, w = w.parentElement) {
          var p = w.parentElement;
          if (!p) break;
          var ch = p.children, mi = -1;
          for (var c = 0; c < ch.length && c < 15; c += 1) { if (ch[c] === w) { mi = c; break; } }
          if (mi < 0) break;
          for (var c = 0; c < mi && c < 8; c += 1) {
            var st2 = norm(ch[c].innerText || ch[c].textContent || '');
            if (st2.length > 2000) break;
            prevTexts.push(st2);
            prevTotalChars += st2.length;
            if (prevTotalChars > 3000) break;
          }
        }
      }
      if (prevTexts.length > 0) { text = prevTexts.join(' | ') + ' | ' + text; }

      var linkHrefs = [];
      // Card links for URL extraction.
      for (var lj = 0; lj < links.length; lj += 1) {
        linkHrefs.push(norm(links[lj].getAttribute('href') || ''));
      }
      // Sibling links.
      for (var lk = 0; lk < siblingLinks.length; lk += 1) {
        linkHrefs.push(norm(siblingLinks[lk].getAttribute('href') || ''));
      }

      var authorHref = '';
      var authorText = '';
      // Primary author: prefer sibling (sharer's header).
      for (var li = 0; li < siblingLinks.length; li += 1) {
        var h = norm(siblingLinks[li].getAttribute('href') || '');
        if (!authorHref && (h.indexOf('/in/') >= 0 || h.indexOf('/company/') >= 0)) {
          authorHref = h;
          authorText = norm(siblingLinks[li].innerText || siblingLinks[li].textContent || '');
        }
      }
      // Fallback: author from card body.
      if (!authorHref) {
        for (var lm = 0; lm < links.length; lm += 1) {
          var h2 = norm(links[lm].getAttribute('href') || '');
          if (h2.indexOf('/in/') >= 0 || h2.indexOf('/company/') >= 0) {
            authorHref = h2;
            authorText = norm(links[lm].innerText || links[lm].textContent || '');
            break;
          }
        }
      }

      var dk = text.slice(0, 80);
      if (seen.has(dk)) continue;
      seen.add(dk);

      cards.push({ text: text, authorHref: authorHref, authorText: authorText, links: linkHrefs });
      if (cards.length >= limit) break;
    } catch (_err) {
      try {
        failed.push(norm((candidates[ci].innerText || candidates[ci].textContent || '')).slice(0, 120));
      } catch (_ignore) {}
    }
  }

  var stillLoading = false;
  var sels = ['[role="progressbar"]', '[class*="loader"]', '[class*="spinner"]', '[aria-busy="true"]'];
  for (var si = 0; si < sels.length; si += 1) {
    var el = document.querySelector(sels[si]);
    if (el && el.offsetParent !== null) { stillLoading = true; break; }
  }

  return { loginRequired: false, cards: cards, failed: failed, stillLoading: stillLoading };
}

// ---------------------------------------------------------------------------
// Scroll helper (Browser CDP)
// ---------------------------------------------------------------------------

function scrollStep() {
  var container = document.querySelector('#workspace') || document.querySelector('main');
  var useWin = false;

  if (!container || container.scrollHeight <= container.clientHeight + 10 ||
      getComputedStyle(container).overflowY === 'visible') {
    if (document.documentElement.scrollHeight > document.documentElement.clientHeight + 10) {
      useWin = true;
    }
  }

  if (!useWin && !container) {
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i += 1) {
      var s = getComputedStyle(all[i]);
      if ((s.overflowY === 'scroll' || s.overflowY === 'auto') &&
          all[i].scrollHeight > all[i].clientHeight + 50) {
        container = all[i];
        break;
      }
    }
  }

  var sh = 0, ch = 0, sc = 0, nb = false;
  var step = Math.max(300, Math.floor((window.innerHeight || 700) * (0.3 + Math.random() * 0.1)));

  if (useWin) {
    var bf = window.scrollY;
    window.scrollBy(0, step);
    sh = document.documentElement.scrollHeight;
    ch = window.innerHeight;
    sc = window.scrollY - bf;
    nb = window.scrollY + window.innerHeight >= sh - 200;
  } else if (container) {
    var bf2 = container.scrollTop;
    container.scrollTop = Math.min(container.scrollTop + step, container.scrollHeight - container.clientHeight);
    sh = container.scrollHeight;
    ch = container.clientHeight;
    sc = container.scrollTop - bf2;
    nb = container.scrollTop + ch >= sh - 200;
  }

  return { scrollH: sh, clientH: ch, scrolled: sc, nearBottom: nb };
}

// ---------------------------------------------------------------------------
// Phase 2 (Node.js): Process raw cards into structured posts
// ---------------------------------------------------------------------------

function parseLinkedInTimeLabel(label, nowMs) {
  var MIN = 60000, HOUR = 3600000, DAY = 86400000;
  var n = String(label || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!n) return null;

  var abs = Date.parse(n);
  if (Number.isFinite(abs)) return abs;

  var pats = [
    [/(\d+)\s*(?:分钟|分|mins?|minutes?)/i, MIN],
    [/(\d+)\s*(?:小时|hrs?|hours?)/i, HOUR],
    [/(\d+)\s*(?:天|days?)/i, DAY],
    [/(\d+)\s*(?:周|weeks?|w)(?!\S)/i, 7 * DAY],
    [/(\d+)\s*(?:个月|月|months?|mos?)(?!\S)/i, 30 * DAY],
  ];
  for (var i = 0; i < pats.length; i += 1) {
    var m = n.match(pats[i][0]);
    if (!m) continue;
    var c = parseInt(m[1], 10);
    if (Number.isFinite(c) && c >= 0) return nowMs - c * pats[i][1];
  }
  return null;
}

function processCards(rawCards, days, maxResults, seen) {
  // seen: shared object for cross-round deduplication (key → {idx, hasTime}).
  // Modified in-place. Cards seen without a time label are replaced when
  // the same card appears again with a time label (common for shared posts).
  var DAY_MS = 86400000;
  var nowMs = Date.now();
  var cutoffMs = nowMs - days * DAY_MS;

  var UM = String.fromCharCode(20998, 38047) + '|' + String.fromCharCode(20998) + '|mins?|minutes?';
  var UH = String.fromCharCode(23567, 26102) + '|hrs?|hours?';
  var UD = String.fromCharCode(22825) + '|days?';
  var UW = String.fromCharCode(21608) + '|weeks?|w';
  var UMo = String.fromCharCode(20010, 26376) + '|' + String.fromCharCode(26376) + '|months?|mos?';
  var UNITS = UM + '|' + UH + '|' + UD + '|' + UW + '|' + UMo;
  var TIME_RE = new RegExp('\\d+\\s*(?:' + UNITS + ')', 'i');
  var TIME_SPLIT = new RegExp('\\d+\\s*(?:' + UNITS + ')', 'i');

  function extractTimeLabel(text) {
    var m = text.match(TIME_RE);
    return m ? m[0].replace(/\s+/g, ' ').trim() : '';
  }

  function isInternal(h) {
    if (!h) return false;
    return h.charAt(0) === '/' || h.indexOf('https://www.linkedin.com/') === 0 || h.indexOf('https://linkedin.com/') === 0;
  }

  function toAbs(h) {
    if (!h) return '';
    if (h.charAt(0) === '/') return 'https://www.linkedin.com' + h;
    return h;
  }

  var rows = [];

  for (var i = 0; i < rawCards.length; i += 1) {
    var card = rawCards[i];
    var text = card.text || '';
    if (!text || text.length < 80) continue;

    var links = card.links || [];
    var authorHref = card.authorHref || '';
    var authorText = card.authorText || '';

    var authorName = authorText;
    if (!authorName) {
      authorName = text.split(TIME_SPLIT)[0].split(String.fromCharCode(8226))[0].trim();
    }

    var timeLabel = extractTimeLabel(text);
    // Fallback: scan full text for absolute dates if time label missing.
    if (!timeLabel) {
      var dateMatch = text.match(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/);
      if (dateMatch) timeLabel = dateMatch[0];
    }
    var resultUrl = '';

    // Priority 1: /feed/update/
    for (var li = 0; li < links.length; li += 1) {
      if (links[li].indexOf('/feed/update/') >= 0) { resultUrl = toAbs(links[li]); break; }
    }
    // Priority 2: /posts/...-activity-...
    if (!resultUrl) {
      for (var lj = 0; lj < links.length; lj += 1) {
        if (links[lj].indexOf('/posts/') >= 0 && /-activity-/.test(links[lj])) { resultUrl = toAbs(links[lj]); break; }
      }
    }
    // Priority 3: First internal non-author link
    if (!resultUrl) {
      for (var lk = 0; lk < links.length; lk += 1) {
        var h = links[lk];
        if (!h || h.indexOf('/in/') >= 0 || h.indexOf('/company/') >= 0 || h.indexOf('/search/') >= 0) continue;
        if (isInternal(h)) { resultUrl = toAbs(h); break; }
      }
    }
    // Decode safety/go
    if (resultUrl && resultUrl.indexOf('/safety/go/') >= 0) {
      try {
        var p = new URL(resultUrl);
        var enc = p.searchParams.get('url');
        if (enc) {
          var dec = decodeURIComponent(enc);
          if (dec.indexOf('https://www.linkedin.com/') === 0 || dec.indexOf('https://linkedin.com/') === 0 || dec.indexOf('https://lnkd.in/') === 0) {
            resultUrl = dec;
          } else { resultUrl = ''; }
        }
      } catch (_e) {}
    }
    // Priority 4: Author link
    if (!resultUrl) { resultUrl = toAbs(authorHref); }

    var dk = resultUrl || authorHref;
    if (seen[dk] !== undefined) {
      // Already seen. Only replace if new version has time and old version doesn't.
      if (!timeLabel || seen[dk].hasTime) continue;
      // Replace old entry: remove it and add new one below.
      var oldIdx = seen[dk].idx;
      if (oldIdx >= 0 && oldIdx < rows.length) {
        rows.splice(oldIdx, 1);
        // Adjust indices of all subsequent seen entries.
        var keys = Object.keys(seen);
        for (var ki = 0; ki < keys.length; ki += 1) {
          var k = keys[ki];
          if (seen[k].idx > oldIdx) seen[k].idx -= 1;
        }
      }
      delete seen[dk];
    }

    var postMs = parseLinkedInTimeLabel(timeLabel, nowMs);
    if (postMs && postMs < cutoffMs) continue;

    rows.push({
      postedAt: postMs ? new Date(postMs).toISOString() : '',
      postedAtLabel: timeLabel,
      url: resultUrl,
      content: text,
      authorHandle: authorHref,
      authorName: authorName,
    });
    seen[dk] = { idx: rows.length - 1, hasTime: !!timeLabel };
    if (rows.length >= maxResults) break;
  }
  // Inherit time labels for shared-post content cards: they appear right
  // after the sharer's card in DOM order and share the same timestamp.
  for (var ri = 0; ri < rows.length; ri += 1) {
    if (rows[ri].postedAtLabel) continue;
    // Check previous card — sharer header always precedes shared content.
    if (ri > 0 && rows[ri - 1].postedAtLabel) {
      rows[ri].postedAtLabel = rows[ri - 1].postedAtLabel;
      rows[ri].postedAt = rows[ri - 1].postedAt;
    } else if (ri + 1 < rows.length && rows[ri + 1].postedAtLabel) {
      // Fallback: next card (rare case, shared card before header in DOM).
      rows[ri].postedAtLabel = rows[ri + 1].postedAtLabel;
      rows[ri].postedAt = rows[ri + 1].postedAt;
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Main scroll + collect loop
// ---------------------------------------------------------------------------

async function scrollAndCollect(targetId, maxRounds, days, maxResults) {
  var rows = [];
  var snapshots = [];
  var totalButtonClicks = 0;
  var stoppedReason = 'max_rounds';

  var zeroNewRounds = 0;
  var ZERO_NEW_THRESHOLD = 2;
  var bottomStallRounds = 0;
  var MAX_BOTTOM_STALL = 3;
  var safetyCap = 200;
  var seen = {};  // shared dedup across rounds (key → {idx, hasTime})

  for (var round = 0; round < safetyCap; round += 1) {
    // Step 1: Scroll
    var sr = await evaluate(targetId, toExpression(scrollStep));
    await sleep(800 + Math.random() * 500);

    // Step 2: Collect — every round near bottom, every 3rd otherwise
    var collectEveryN = sr && sr.nearBottom ? 1 : 3;
    if (round % collectEveryN !== 0 && sr && !sr.nearBottom) {
      await evaluate(targetId, toExpression(scrollStep));
      await sleep(800 + Math.random() * 500);
      continue;
    }

    var payload = await evaluate(targetId, toExpression(collectRawCards, 60));
    if (!payload) {
      payload = { loginRequired: false, cards: [], failed: [], stillLoading: false };
    }

    if (payload.loginRequired) {
      snapshots.push({ round: round, loginRequired: true });
      break;
    }

    if (payload.failed && payload.failed.length > 0) {
      console.error('round %d: %d card(s) failed extraction', round, payload.failed.length);
    }

    // Process raw cards in Node.js
    var newRows = processCards(payload.cards || [], days, maxResults, seen);
    var newThisRound = 0;
    for (var i = 0; i < newRows.length; i += 1) {
      rows.push(newRows[i]);
      newThisRound += 1;
    }
    snapshots.push({ round: round, cards: (payload.cards || []).length, new: newThisRound, total: rows.length });

    // --- Handle stillLoading — may persist even at true bottom ---
    // When bottom-stalled: still at bottom, no new cards for consecutive rounds.
    if (sr && sr.nearBottom && newThisRound === 0) {
      bottomStallRounds += 1;
      if (bottomStallRounds >= MAX_BOTTOM_STALL) {
        stoppedReason = 'bottom_reached';
        break;
      }
    } else {
      bottomStallRounds = 0;
    }

    if (newThisRound > 0) {
      zeroNewRounds = 0;
      continue;
    }

    // stillLoading but not stalled yet — give it time
    if (payload.stillLoading) {
      continue;
    }

    // Not near bottom and still scrolling — keep going
    if (sr && !sr.nearBottom && sr.scrolled > 5) {
      continue;
    }

    // --- Near bottom, no new posts, not loading ---
    // Step 1: Bounce to trigger lazy load.
    var upExpr = "(function(){var c=document.querySelector('#workspace')||document.querySelector('main');var up=Math.floor((window.innerHeight||700)*0.5);if(c&&c.scrollHeight>c.clientHeight+10&&getComputedStyle(c).overflowY!=='visible'){c.scrollTop=Math.max(0,c.scrollTop-up);}else{window.scrollBy(0,-up);}})()";
    await evaluate(targetId, upExpr);
    await sleep(1500);
    var downExpr = "(function(){var c=document.querySelector('#workspace')||document.querySelector('main');if(c&&c.scrollHeight>c.clientHeight+10&&getComputedStyle(c).overflowY!=='visible'){c.scrollTop=c.scrollHeight-c.clientHeight;}else{window.scrollTo(0,document.documentElement.scrollHeight);}})()";
    await evaluate(targetId, downExpr);
    await sleep(2000);

    var afterBounce = await evaluate(targetId, toExpression(collectRawCards, 60));
    var bounceNew = 0;
    if (afterBounce && afterBounce.cards) {
      var bounceRows = processCards(afterBounce.cards, days, maxResults, seen);
      for (var k = 0; k < bounceRows.length; k += 1) {
        rows.push(bounceRows[k]);
        bounceNew += 1;
      }
    }

    if (bounceNew > 0) {
      zeroNewRounds = 0;
      bottomStallRounds = 0;
      continue;
    }

    // Bounce found nothing — page may still be rendering.
    if (afterBounce && afterBounce.stillLoading) {
      continue;
    }

    // Step 2: Bounce didn't help — check for paginated "load more" button.
    // Find a visible button near the bottom of the main content area.
    // No CSS class or text matching — purely structural (position-based).
    var btnExpr = "(function(){var c=document.querySelector('#workspace')||document.querySelector('main');if(!c)return{clicked:false};var btns=c.querySelectorAll('button');var best=null;var bestDist=Infinity;var bh=c.scrollHeight;for(var i=0;i<btns.length;i++){if(btns[i].offsetParent===null)continue;var r=btns[i].getBoundingClientRect();var d=bh-r.bottom;if(d>=0&&d<bestDist){bestDist=d;best=btns[i];}}if(best&&bestDist<400){best.scrollIntoView({block:'center'});best.click();return{clicked:true};}return{clicked:false};})()";
    var btnResult = await evaluate(targetId, btnExpr);
    btnResult = btnResult || { clicked: false };

    if (btnResult.clicked) {
      totalButtonClicks += 1;
      await sleep(4000 + Math.random() * 2000);
      var afterClick = await evaluate(targetId, toExpression(collectRawCards, 60));
      if (afterClick && afterClick.cards) {
        var clickRows = processCards(afterClick.cards, days, maxResults, seen);
        var clickNew = 0;
        for (var j = 0; j < clickRows.length; j += 1) {
          rows.push(clickRows[j]);
          clickNew += 1;
        }
        if (clickNew > 0) {
          zeroNewRounds = 0;
          bottomStallRounds = 0;
          continue;
        }
      }
    }

    // Step 3: Neither bounce nor button helped — count as dead round.
    zeroNewRounds += 1;
    if (zeroNewRounds >= ZERO_NEW_THRESHOLD) {
      stoppedReason = 'bottom_reached';
      break;
    }
  }

  return {
    rows: rows,
    scrollStatus: {
      actualRounds: snapshots.length,
      maxRounds: maxRounds,
      stoppedReason: stoppedReason,
      totalDiscovered: rows.length,
      buttonClicks: totalButtonClicks,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  var args = parseArgs(process.argv.slice(2));
  var finalUrl = buildLinkedInSearchUrl(args.keyword);

  if (args.dryRun) {
    console.log(JSON.stringify({
      keyword: args.keyword, days: args.days, url: finalUrl,
      maxScrolls: args.maxScrolls, maxResults: args.maxResults,
    }, null, 2));
    return;
  }

  await ensureHostBrowserBridge();

  // Clean stale tabs
  try {
    var tr = await requestHostBrowser({ action: 'list_targets' }, { timeoutMs: 10000 });
    var stale = (tr && tr.targets || []).filter(function (t) {
      return t.url && t.url.indexOf('linkedin.com/search/results/content') >= 0;
    });
    for (var si = 0; si < stale.length; si += 1) {
      await requestHostBrowser({ action: 'close_target', targetId: stale[si].id }, { timeoutMs: 5000 }).catch(function () {});
    }
    if (stale.length > 0) console.error('Cleaned %d stale tab(s)', stale.length);
  } catch (_) {}

  var targetId = null;
  var shutdown = function () {
    if (targetId) { closeTarget(targetId).then(function () { process.exit(0); }); }
    else { process.exit(0); }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  try {
    targetId = await createTarget(finalUrl);
    console.error('waiting for page...');
    await sleep(8000);

    var title = await evaluate(targetId, 'document.title');
    console.error('page: %s', title);

    // Detect login redirect (structural check only — no text/regex on page content)
    var path = await evaluate(targetId, 'location.pathname');
    if (typeof path === 'string' && (path.indexOf('/login') === 0 || path.indexOf('/checkpoint') === 0 || path.indexOf('/uas/login') === 0)) {
      var loginResult = buildSearchResultJson({
        keyword: args.keyword, finalUrl: finalUrl,
        preflight: { ok: false, error: 'LOGIN_REQUIRED' },
        scrollNote: 'Login required', rows: [],
      });
      console.log(JSON.stringify(loginResult, null, 2));
      return;
    }

    var preflight = { ok: true, title: title, path: path };

    var collected = await scrollAndCollect(targetId, args.maxScrolls, args.days, args.maxResults);

    if (args.debugDump) {
      fs.writeFileSync(args.debugDump, JSON.stringify({
        keyword: args.keyword, days: args.days, finalUrl: finalUrl,
        candidateCount: collected.rows.length, rows: collected.rows,
      }, null, 2), 'utf8');
    }

    var ss = collected.scrollStatus;
    var btnInfo = ss.buttonClicks > 0 ? ' (button: ' + ss.buttonClicks + ')' : '';
    var scrollNote = ss.stoppedReason === 'bottom_reached'
      ? 'Bottom reached (' + ss.actualRounds + ' rounds, ' + ss.totalDiscovered + ' posts)' + btnInfo
      : ss.actualRounds + '/' + ss.maxRounds + ' rounds (' + ss.totalDiscovered + ' posts)' + btnInfo;

    var result = buildSearchResultJson({
      keyword: args.keyword, finalUrl: finalUrl,
      preflight: preflight, scrollNote: scrollNote, rows: collected.rows,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (targetId) {
      try { await closeTarget(targetId); } catch (e) { console.error('close err: %s', (e && e.message) || e); }
    }
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
  }
}

main().catch(function (e) { console.error((e && e.message) || String(e)); process.exit(1); });
