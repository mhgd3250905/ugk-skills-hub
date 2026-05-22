(function(){
  var rows = document.querySelectorAll('[class*="vurnku"]');
  var invites = [];
  rows.forEach(function(row) {
    var qLink = row.querySelector('a[href*="/question/"]');
    if (!qLink) return;
    var match = qLink.href.match(/\/question\/(\d+)/);
    if (!match) return;
    var text = row.textContent.trim();
    var type = 'unknown';
    if (text.indexOf('邀请你回答') >= 0 || text.indexOf('邀请您回答') >= 0) {
      type = 'invited_me';
    } else if (text.indexOf('期待你的解答') >= 0) {
      type = 'question_expects';
    }
    invites.push({
      questionId: match[1],
      questionUrl: qLink.href,
      questionTitle: qLink.textContent.trim(),
      type: type,
      fullText: text
    });
  });
  return JSON.stringify(invites);
})()
