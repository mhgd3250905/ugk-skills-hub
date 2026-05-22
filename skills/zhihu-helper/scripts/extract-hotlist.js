(function() {
  // 注意：调用前应确保页面 readyState 为 complete
  const items = document.querySelectorAll(".HotList-list .HotItem");
  return JSON.stringify(Array.from(items).map((item, i) => ({
    rank: item.querySelector(".HotItem-index")?.textContent?.trim() || String(i+1),
    title: item.querySelector(".HotItem-title")?.textContent?.trim(),
    excerpt: item.querySelector(".HotItem-excerpt")?.textContent?.trim()?.substring(0,100),
    metrics: item.querySelector(".HotItem-metrics")?.textContent?.trim(),
    url: item.querySelector("a")?.href,
    questionId: (item.querySelector("a")?.href?.match(/question\/(\d+)/) || [])[1]
  })));
})()