(async function() {
  const qid = "QUESTION_ID_PLACEHOLDER";
  const resp = await fetch(
    `https://www.zhihu.com/api/v4/questions/${qid}/answers?limit=20&offset=0&sort_by=votes&include=data[*].is_normal,content,voteup_count,comment_count,created_time,author.name`,
    { credentials: "include" }
  );
  const data = await resp.json();
  return JSON.stringify({
    total: data.paging?.totals,
    is_end: data.paging?.is_end,
    answers: data.data.map(a => ({
      id: a.id,
      author: a.author?.name || "匿名",
      voteup_count: a.voteup_count,
      comment_count: a.comment_count,
      excerpt: (a.content?.replace(/<[^>]+>/g, "") || "").substring(0, 200),
      created_time: a.created_time
    }))
  });
})()