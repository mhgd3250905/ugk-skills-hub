# 文字配图发布（AI 自动生成配图）

## 前置条件

web-access sidecar 运行中 + 小红书创作者平台已登录。

## 命令方式

```bash
python3 scripts/publish-note.py \
  --title "逃离城市喧嚣｜嵊泗海岛治愈之旅💙" \
  --content-file /tmp/my-note.txt \
  --style 光影

# 或直接传内容
python3 scripts/publish-note.py \
  --title "标题" \
  --content "正文内容..." \
  --style 简约
```

**参数**：

| 参数 | 说明 |
|------|------|
| `--title` | 标题，5-20字，用｜分隔关键词语，末尾可加 emoji |
| `--content` / `--content-file` | 图片配文内容（会被拆成多张卡片） |
| `--description` / `--description-file` | 笔记正文（在发布预览页面填写的完整读后感，可选） |
| `--style` | AI 配图风格：`光影` / `简约` / `备忘` / `边框` / `便签` |

**示例：带独立正文的发布**

```bash
python3 scripts/publish-note.py \
  --title "AI转型没戏，得重新投胎🥶" \
  --content-file /tmp/cards.txt \
  --description-file /tmp/full-review.txt \
  --style 便签
```
`--content-file` 是每张卡片上的短文案，`--description-file` 是发布后笔记详情页展示的完整读后感。

**返回**：
- `ok` — 是否成功
- `published` — 是否发布成功
- `elapsed` — 耗时

---

## 完整步骤（手动方式）

```bash
AGENT_SCOPE="xhs-publish"
TARGET_ID=$(curl -s "http://127.0.0.1:3456/new?url=https://creator.xiaohongshu.com/publish/publish?source=official&from=menu&target=image&metaAgentScope=${AGENT_SCOPE}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('targetId',''))")
sleep 4

# 1. 点击"上传图文"
curl -s -X POST "http://127.0.0.1:3456/eval?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}" \
  -H "Content-Type: application/json" \
  -d '(() => { const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.includes("上传图文")); if (btn) { btn.click(); return "clicked"; } return "not found"; })()'
sleep 2

# 2. 点击"文字配图"
curl -s -X POST "http://127.0.0.1:3456/eval?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}" \
  -H "Content-Type: application/json" \
  -d '(() => { const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.includes("文字配图")); if (btn) { btn.click(); return "clicked"; } return "not found"; })()'
sleep 2

# 3. 填写正文
CONTENT=$(python3 -c "import json; print(json.dumps('正文内容...'.join('\n')))")
curl -s -X POST "http://127.0.0.1:3456/eval?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}" \
  -H "Content-Type: application/json" \
  -d "(() => { const editor = document.querySelector('.ProseMirror'); if (editor) { editor.focus(); document.execCommand('insertText', false, ${CONTENT}); return {ok: true}; } return {error: 'editor not found'}; })()"

# 4. 点击"生成图片"
curl -s -X POST "http://127.0.0.1:3456/eval?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}" \
  -H "Content-Type: application/json" \
  -d '(() => { const span = Array.from(document.querySelectorAll("span")).find(s => s.textContent?.includes("生成图片")); if (span) { const btn = span.closest("button") || span.parentElement; btn.click(); return "clicked"; } return "not found"; })()'
sleep 15

# 5. 选择风格（可选）
curl -s -X POST "http://127.0.0.1:3456/eval?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}" \
  -H "Content-Type: application/json" \
  -d '(() => { const btn = Array.from(document.querySelectorAll("div, span, button")).find(el => el.textContent?.trim() === "光影"); if (btn) { btn.click(); return "clicked"; } return "not found"; })()'
sleep 2

# 6. 点击"下一步"
curl -s -X POST "http://127.0.0.1:3456/eval?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}" \
  -H "Content-Type: application/json" \
  -d '(() => { const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.trim() === "下一步"); if (btn) { btn.click(); return "clicked"; } return "not found"; })()'
sleep 3

# 7. 填写标题
curl -s -X POST "http://127.0.0.1:3456/eval?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}" \
  -H "Content-Type: application/json" \
  -d '(() => { const input = document.querySelector("input[placeholder*=\"标题\"]"); if (input) { input.focus(); input.value = "标题内容"; input.dispatchEvent(new Event("input", {bubbles: true})); return "filled"; } return "not found"; })()'

# 8. 点击"发布"
curl -s -X POST "http://127.0.0.1:3456/eval?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}" \
  -H "Content-Type: application/json" \
  -d '(() => { const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.trim() === "发布"); if (btn) { btn.click(); return "clicked"; } return "not found"; })()'
sleep 3

# 9. 验证发布成功
curl -s -X POST "http://127.0.0.1:3456/eval?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}" \
  -H "Content-Type: application/json" \
  -d '(() => ({ url: window.location.href, published: window.location.href.includes("published=true") }))()'

curl -s -X DELETE "http://127.0.0.1:3456/close?target=${TARGET_ID}&metaAgentScope=${AGENT_SCOPE}"
```

---

## ⚠️ 关键限制

### 字数限制

| 限制项 | 上限 | 超出后果 |
|--------|------|----------|
| 每张图正文 | **500字** | 提示"最多500字"，无法生成 |
| 每张图显示行数 | **9行**（含空行） | 超出被截断或挤到下一页 |
| 每行最大字数 | **12字** | 自动换行，挤占下一行位置 |
| 标题 | **20字** | 超出部分截断或报错 |
| 图片数量 | 无明确上限 | 建议5张以内 |

**手动排版建议**：每张卡片按 **≤9行、每行≤12字** 设计，用 `---` 分隔符手动控制分页。

**自动分页备用**：脚本 `split_content_to_pages()` 会按 12行/108字 宽松上限自动拆分。

### 排版

- `insertText` 的 `\n` 不会被 ProseMirror 解析为段落，换行会丢失
- ✅ 脚本已修复：改用 `execCommand('insertHTML')` + `<p>` 标签保留换行
- 如手动操作，注意换行排版

### 手动分页

在正文内容中用 `---`（前后各一个空行）分隔，脚本会按此精确分页：

```
第一张卡片的内容

---

第二张卡片的内容
```

**适用场景**：当你想精确控制每张卡片的断句位置（比如每张9行以內），而非让脚本自动按字数截断。

### 多页流程

```
正确：封面→添加正文页→写完所有→最后生成图片
错误：写一张→生成一张→再写一张（浪费时间）
```

### 按钮选择器

- ❌ `querySelectorAll("*")` 匹配文本会点到父元素
- ✅ 文字配图：`button.text2image-button`（精确匹配）
- ✅ 再写一张：`div.add-text-item-button` → `span.add-text-item-button-text`
- ✅ 上传图文/发布/下一步等通用按钮：`button.d-button`

### 等待时间

| 操作 | 等待时长 |
|------|----------|
| 页面加载 | **8秒** |
| 编辑器加载 | 轮询检测 2-4秒 |
| 图片生成 | **30秒** |
| 模式切换 | **5秒** |

**编辑器加载检测**：轮询 `[contenteditable=true]` 或 `.ProseMirror` 元素

### 发布成功验证

```javascript
(() => ({
  url: window.location.href,
  published: window.location.href.includes("success") || 
             document.body.textContent?.includes("发布成功")
}))()
```
成功 URL 跳转到 `/publish/success`。

---

## Style 选择

| 风格 | 适合内容 |
|------|----------|
| 光影 | 风景、海景、自然 |
| 简约 | 日常、美食、生活 |
| 备忘 | 攻略、Tips、清单 |
| 边框 | 人物、产品 |
| 便签 | 文字为主的内容 |
