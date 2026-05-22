# 图片上传发布

需要提前准备图片，使用 CDP 命令上传。

## 准备图片

```bash
mkdir -p /app/.data/browser-upload
cp /path/to/images/*.jpg /app/.data/browser-upload/
# sidecar 容器路径对应：/config/upload/<file>
```

## 推荐脚本

```bash
node scripts/publish-with-images.mjs \
  --title "逃离城市｜嵊泗海岛治愈之旅🌊" \
  --content "正文内容..." \
  --images img1.jpg,img2.jpg,img3.jpg,img4.jpg
```

脚本自动处理 scope / TARGET_ID / 页面关闭。

---

## ⚠️ 关键坑点

### 必须先切换图文模式

发布页面默认是 **视频模式**（file input accept=".mp4,.mov"），必须先点击"上传图文"切换到图文模式。

```javascript
// 检查模式
(() => {
  const inputs = document.querySelectorAll('input[type="file"]');
  inputs.forEach(inp => console.log(inp.accept));
})()

// 点击切换
(() => {
  const el = Array.from(document.querySelectorAll('*')).find(e => e.textContent?.trim() === '上传图文');
  if (el) { el.click(); return 'clicked'; }
  return 'not found';
})()
```

### 必须使用 CDP 命令上传

JavaScript fetch 跨容器会失败（sidecar 与 app 网络隔离）。唯一可行方法：`DOM.setFileInputFiles`。

### 图片路径映射

| 环境 | 路径 |
|------|------|
| agent/app 容器 | `/app/.data/browser-upload/<file>` |
| sidecar Chrome | `/config/upload/<file>` |
| CDP setFileInputFiles | 用 sidecar 路径 |

### 页面关闭陷阱

- ❌ 直接用 CDP WebSocket 直连绕过代理 scope → 误关别人页面
- ✅ 全程用代理 API（`/new` → `/eval` → `/close`）
- ✅ 如果用 CDP 直连，记录自己的 TARGET_ID，只关闭自己的页面

### 发布成功验证

成功后 URL 跳转到 `/publish/success`：

```javascript
(() => ({ url: window.location.href, published: window.location.href.includes("success") }))()
```
