(function() {
  const titleEl = document.querySelector("h1.QuestionHeader-title");
  const bodyText = document.body.innerText;
  
  // 提取关注者数量
  const followersMatch = bodyText.match(/(\d+(?:\.\d+)?[万亿]?)\s*(?:个?关注者?|人关注)/);
  const followers = followersMatch ? followersMatch[1] : null;
  
  // 提取回答数量
  const answersMatch = bodyText.match(/(\d+)\s*(?:个)?回答/);
  const answerCount = answersMatch ? answersMatch[1] : null;
  
  // 从 URL 提取问题 ID
  const questionId = (window.location.href.match(/question\/(\d+)/) || [])[1];
  
  return JSON.stringify({
    title: titleEl?.textContent?.trim(),
    questionId: questionId,
    followers: followers,
    answerCount: answerCount,
    url: window.location.href
  });
})()