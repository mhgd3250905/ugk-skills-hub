const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function trimSummary(text, limit = 320) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '（内容为空）';
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function deriveTitle(text, maxLength = 160) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '（无标题）';
  const firstSentence =
    raw
      .split(/[.!?。！？]/)[0]
      .replace(/\s+/g, ' ')
      .trim() || raw;
  if (firstSentence.length <= maxLength) return firstSentence;
  return `${firstSentence.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function buildMatchReason(item, keyword) {
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedKeyword) return 'unknown';

  const text = normalizeText(item?.content || '');
  if (text.includes(normalizedKeyword)) return 'content';

  const title = normalizeText(item?.title || '');
  if (title.includes(normalizedKeyword)) return 'title';

  const author = normalizeText(
    [item?.authorName, item?.authorHandle].filter(Boolean).join(' '),
  );
  if (author.includes(normalizedKeyword)) return 'author';

  return 'visible_text';
}

function parseAbsoluteDate(value) {
  const parsed = Date.parse(String(value || '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseLinkedInVisibleTime(label, nowMs = Date.now()) {
  const normalized = String(label || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return null;

  const absoluteMs = parseAbsoluteDate(normalized);
  if (Number.isFinite(absoluteMs)) return absoluteMs;

  const relativePatterns = [
    { pattern: /(\d+)\s*(?:分钟|分|mins?|minutes?)/i, unitMs: MINUTE_MS },
    { pattern: /(\d+)\s*(?:小时|hrs?|hours?)/i, unitMs: HOUR_MS },
    { pattern: /(\d+)\s*(?:天|days?)/i, unitMs: DAY_MS },
    { pattern: /(\d+)\s*(?:周|weeks?|w)(?!\S)/i, unitMs: 7 * DAY_MS },
    { pattern: /(\d+)\s*(?:个月|月|months?|mos?)(?!\S)/i, unitMs: 30 * DAY_MS },
  ];

  for (const entry of relativePatterns) {
    const match = normalized.match(entry.pattern);
    if (!match) continue;
    const count = Number.parseInt(match[1], 10);
    if (Number.isFinite(count) && count >= 0) {
      return nowMs - count * entry.unitMs;
    }
  }

  return null;
}

export function buildLinkedInSearchUrl(keyword) {
  return `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(keyword)}&origin=FACETED_SEARCH&sortBy=%5B%22date_posted%22%5D&datePosted=%5B%22past-month%22%5D`;
}

export function selectRecentRelevantPosts(items, options) {
  const keyword = String(options?.keyword || '').trim();
  const days = Math.max(1, Number(options?.days || 30));
  const nowMs = Number(options?.nowMs || Date.now());
  const normalizedKeyword = normalizeText(keyword);
  const cutoffMs = nowMs - days * DAY_MS;
  const seen = new Set();

  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const postedAt = String(item?.postedAt || '').trim();
      const postedAtLabel = String(item?.postedAtLabel || '').trim();
      const postedAtMs =
        parseAbsoluteDate(postedAt) ?? parseLinkedInVisibleTime(postedAtLabel, nowMs);
      const url = String(item?.url || '').trim();
      const content = String(item?.content || '').replace(/\s+/g, ' ').trim();
      const authorHandle = String(item?.authorHandle || '')
        .replace(/\s+/g, ' ')
        .trim();
      const authorName = String(item?.authorName || '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!url || !content || !Number.isFinite(postedAtMs) || postedAtMs < cutoffMs) {
        return null;
      }

      const haystack = normalizeText([content, authorHandle, authorName].join(' '));
      const kwWords = normalizedKeyword
        .split(/\s+/)
        .filter(Boolean);
      const kwFullMatch = haystack.includes(normalizedKeyword);
      const kwWordMatch =
        kwWords.length > 1 && kwWords.every((w) => haystack.includes(w));
      if (!normalizedKeyword || !(kwFullMatch || kwWordMatch)) {
        return null;
      }

      return {
        url,
        postedAt: postedAt || new Date(postedAtMs).toISOString(),
        postedAtLabel,
        postedAtMs,
        authorHandle: authorHandle || 'unknown',
        authorName: authorName || '',
        title: deriveTitle(content),
        content: trimSummary(content, 320),
        matchReason: buildMatchReason(
          {
            content,
            title: deriveTitle(content),
            authorHandle,
            authorName,
          },
          keyword,
        ),
      };
    })
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    })
    .sort((left, right) => right.postedAtMs - left.postedAtMs);
}

/**
 * Validate and build the structured JSON output from collected rows.
 * Each item must pass validation or be dropped.
 */
export function buildSearchResultJson({ keyword, finalUrl, preflight, scrollNote, rows }) {
  const now = new Date().toISOString();

  const validItems = [];
  const dropped = [];

  for (const row of rows) {
    // Use postedAtLabel directly - relative time text is sufficient for monitoring
    const date = String(row.postedAtLabel || row.postedAt || '').trim();
    const authorName = String(row.authorName || '').trim();
    const authorHandle = String(row.authorHandle || '').trim();
    const content = String(row.content || '').replace(/\s+/g, ' ').trim();
    let url = String(row.url || '').trim();

    // --- Built-in validation ---

    // date: just must not be empty
    if (!date) {
      dropped.push({ reason: 'empty_date', authorName });
      continue;
    }

    // authorHandle: must be non-empty, from /in/ or /company/
    if (!authorHandle || (!authorHandle.includes('/in/') && !authorHandle.includes('/company/'))) {
      dropped.push({ reason: 'invalid_author_handle', authorHandle, authorName });
      continue;
    }

    // content: must be non-empty, >= 20 chars
    if (!content || content.length < 20) {
      dropped.push({ reason: 'content_too_short', len: content.length, authorName });
      continue;
    }

    // url: if not empty, must look like a LinkedIn URL
    if (url && !url.startsWith('https://www.linkedin.com/') && !url.startsWith('https://linkedin.com/') && !url.startsWith('https://lnkd.in/')) {
      url = '';
    }
    // url may be empty (not a hard failure)

    validItems.push({
      date,
      authorName,
      authorHandle,
      content,
      url: url || null,
    });
  }

  return {
    platform: 'LinkedIn',
    keyword,
    retrievedAt: now,
    queryUrl: finalUrl,
    preflight,
    scrollNote,
    total: validItems.length,
    dropped: dropped.length,
    items: validItems,
  };
}

export function formatLinkedInSearchResult(input) {
  return buildSearchResultJson(input);
}