const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function collectCandidateText(item) {
  const desc = String(item?.desc || '').trim();
  const contentParts = Array.isArray(item?.contents)
    ? item.contents.map((entry) => String(entry?.desc || '').trim())
    : [];
  const hashtagParts = Array.isArray(item?.textExtra)
    ? item.textExtra.map((entry) => String(entry?.hashtagName || '').trim())
    : [];
  const challengeParts = Array.isArray(item?.challenges)
    ? item.challenges.map((entry) => String(entry?.title || '').trim())
    : [];
  return uniqueStrings([desc, ...contentParts, ...hashtagParts, ...challengeParts]).join(
    ' ',
  );
}

function buildVideoUrl(item) {
  const author = String(item?.author?.uniqueId || '').trim();
  const id = String(item?.id || '').trim();
  if (!author || !id) return '';
  return `https://www.tiktok.com/@${author}/video/${id}`;
}

function formatDateFromSeconds(seconds) {
  const ms = toNumber(seconds) * 1000;
  if (!ms) return '时间未完整解析';
  return new Date(ms).toISOString().slice(0, 10);
}

function trimSummary(text, limit = 220) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '（内容为空）';
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, limit - 3)}...`;
}

export function shouldContinueCollectingPayloads(options) {
  const step = Math.max(0, toNumber(options?.step));
  const maxPages = Math.max(1, toNumber(options?.maxPages || 2));
  const seenAnyUrls = Boolean(options?.seenAnyUrls);
  const consecutiveIdleRounds = Math.max(
    0,
    toNumber(options?.consecutiveIdleRounds),
  );

  if (step < maxPages) {
    return true;
  }

  if (!seenAnyUrls) {
    return step < maxPages + 2 && consecutiveIdleRounds < 4;
  }

  return consecutiveIdleRounds < 2;
}

export function buildTikTokSearchUrl(keyword) {
  return `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`;
}

export function selectRecentRelevantVideos(items, options) {
  const keyword = String(options?.keyword || '').trim();
  const days = Math.max(1, toNumber(options?.days || 30));
  const nowMs = toNumber(options?.nowMs || Date.now());
  const normalizedKeyword = normalizeText(keyword);
  const cutoffMs = nowMs - days * DAY_MS;

  const seenIds = new Set();

  return items
    .map((item) => {
      const candidateText = collectCandidateText(item);
      const normalizedCandidateText = normalizeText(candidateText);
      const createdMs = toNumber(item?.createTime) * 1000;
      const kwWords = normalizedKeyword
        .split(/\s+/)
        .filter(Boolean);
      const kwFullMatch = normalizedCandidateText.includes(normalizedKeyword);
      // For multi-word keywords, allow matching each word anywhere in the text
      const kwWordMatch =
        kwWords.length > 1 && kwWords.every((w) => normalizedCandidateText.includes(w));
      if (!normalizedKeyword || !(kwFullMatch || kwWordMatch)) {
        return null;
      }
      if (!createdMs || createdMs < cutoffMs) {
        return null;
      }

      return {
        id: String(item?.id || ''),
        url: buildVideoUrl(item),
        author: String(item?.author?.uniqueId || '').trim() || 'unknown',
        createdAt: formatDateFromSeconds(item?.createTime),
        createdMs,
        title: trimSummary(String(item?.desc || '').trim() || candidateText, 160),
        content: trimSummary(candidateText, 320),
        diggCount: toNumber(item?.stats?.diggCount ?? item?.statsV2?.diggCount),
        commentCount: toNumber(
          item?.stats?.commentCount ?? item?.statsV2?.commentCount,
        ),
        matchReason: normalizedCandidateText === normalizeText(item?.desc || '')
          ? 'desc'
          : 'desc+hashtags',
      };
    })
    .filter(Boolean)
    .filter((item) => {
      const dedupeKey = item.id || item.url;
      if (!dedupeKey || seenIds.has(dedupeKey)) {
        return false;
      }
      seenIds.add(dedupeKey);
      return true;
    })
    .sort((left, right) => right.createdMs - left.createdMs);
}

export function formatTikTokSearchResult(input) {
  const scrollNote = input.scrollNote ? `滚动状态：${input.scrollNote}` : '';
  const lines = [
    'TikTok Latest 查询结果',
    `关键词：${input.keyword}`,
    `时间范围：最近 ${input.days} 天`,
    `查询地址：${input.finalUrl}`,
    scrollNote,
    '',
    `结果概览：${input.note}`,
    '',
  ].filter(Boolean);

  if (!Array.isArray(input.items) || input.items.length === 0) {
    lines.push('结果列表：未检索到满足条件的结果。');
    return lines.join('\n');
  }

  lines.push('结果列表：');

  input.items.forEach((item, index) => {
    lines.push(`${index + 1}. 时间：${item.createdAt}`);
    lines.push(`   账号：${item.author}`);
    lines.push(`   标题：${item.title}`);
    lines.push(`   内容：${item.content}`);
    lines.push(`   点赞数：${item.diggCount}`);
    lines.push(`   评论数：${item.commentCount}`);
    lines.push(`   匹配依据：${item.matchReason}`);
    lines.push(`   链接：${item.url}`);
  });

  return lines.join('\n');
}