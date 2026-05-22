(async function() {
  const answerId = "ANSWER_ID_PLACEHOLDER";
  const resp = await fetch(
    `https://www.zhihu.com/api/v4/answers/${answerId}?include=content,voteup_count,comment_count,created_time,author.name,author.avatar_url`,
    { credentials: "include" }
  );
  const data = await resp.json();
  return JSON.stringify({
    id: data.id,
    author: data.author?.name,
    author_avatar: data.author?.avatar_url,
    voteup_count: data.voteup_count,
    comment_count: data.comment_count,
    created_time: data.created_time,
    content: data.content?.replace(/<[^>]+>/g, ""),
    content_html: data.content
  });
})()