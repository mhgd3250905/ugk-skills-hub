// 提取创作者平台笔记列表数据
(() => {
  // 查找笔记卡片
  const noteCards = document.querySelectorAll('.note-item, .publish-item, [class*="note-card"]');
  
  if (!noteCards.length) {
    // 尝试其他选择器
    const items = document.querySelectorAll('a[href*="/explore/"]');
    return {
      ok: false,
      error: '未找到笔记列表',
      hint: '请确保已打开笔记管理页面',
      url: window.location.href
    };
  }
  
  // 提取数据
  const notes = Array.from(noteCards).slice(0, 20).map(card => {
    const title = card.querySelector('[class*="title"]')?.textContent?.trim() || '';
    const cover = card.querySelector('img')?.src || '';
    const link = card.querySelector('a')?.href || '';
    const noteId = link.match(/explore\/([^/?]+)/)?.[1] || '';
    
    // 尝试提取统计数据
    const likes = card.querySelector('[class*="like"]')?.textContent?.trim() || '0';
    const collects = card.querySelector('[class*="collect"]')?.textContent?.trim() || '0';
    const comments = card.querySelector('[class*="comment"]')?.textContent?.trim() || '0';
    
    return {
      title,
      cover,
      link,
      noteId,
      stats: { likes, collects, comments }
    };
  });
  
  return {
    ok: true,
    count: notes.length,
    notes,
    url: window.location.href
  };
})();