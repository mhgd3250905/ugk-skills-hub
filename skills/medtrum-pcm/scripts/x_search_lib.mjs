const DAY_MS = 24 * 60 * 60 * 1000;

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

export function buildXSearchUrl(keyword) {
  return `https://x.com/search?q=${encodeURIComponent(keyword)}&src=typed_query&f=live`;
}

export function selectRecentRelevantTweets(items, options) {
  const keyword = String(options?.keyword || '').trim();
  const days = Math.max(1, Number(options?.days || 30));
  const nowMs = Number(options?.nowMs || Date.now());
  const normalizedKeyword = normalizeText(keyword);
  const cutoffMs = nowMs - days * DAY_MS;
  const seen = new Set();

  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const postedAt = String(item?.postedAt || '').trim();
      const postedAtMs = Date.parse(postedAt);
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
      if (!normalizedKeyword || !haystack.includes(normalizedKeyword)) {
        return null;
      }

      return {
        url,
        postedAt,
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

export function formatXSearchResult(input) {
  const lines = [
    'X Latest 查询结果',
    `关键词：${input.keyword}`,
    `时间范围：最近 ${input.days} 天`,
    `查询地址：${input.finalUrl}`,
    '',
    `结果概览：${input.note}`,
  ];

  // 添加滚动状态
  if (input.scrollStatus) {
    const { actualScrolls, maxScrolls, stoppedReason } = input.scrollStatus;
    const statusText = stoppedReason === 'no_new_content'
      ? `滚动状态：${actualScrolls}/${maxScrolls} 次，已到底部（连续无新内容）`
      : `滚动状态：${actualScrolls}/${maxScrolls} 次，达到上限`;
    lines.push(statusText);
  }

  lines.push('');

  if (!Array.isArray(input.items) || input.items.length === 0) {
    lines.push('结果列表：未检索到满足条件的结果。');
    return lines.join('\n');
  }

  lines.push('结果列表：');
  input.items.forEach((item, index) => {
    lines.push(`${index + 1}. 时间：${String(item.postedAt || '').slice(0, 10) || '时间未完整解析'}`);
    lines.push(
      `   账号：${[item.authorName, item.authorHandle].filter(Boolean).join(' / ') || 'unknown'}`,
    );
    lines.push(`   标题：${item.title || '（无标题）'}`);
    lines.push(`   内容：${item.content || '（内容为空）'}`);
    lines.push(`   匹配依据：${item.matchReason || 'unknown'}`);
    lines.push(`   链接：${item.url}`);
  });

  return lines.join('\n');
}