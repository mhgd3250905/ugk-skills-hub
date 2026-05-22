---
name: xhs-helper
description: 小红书笔记发布、内容创作、关键词检索。当用户提到小红书、笔记、发帖、小红书发布、小红书创作、小红书搜索、小红书数据时，必须使用此技能。此技能依赖 web-access 浏览器 sidecar，需要小红书创作者平台登录态。
---

# 小红书创作助手

提供小红书图文笔记发布、关键词检索和数据获取能力。依赖 web-access 浏览器 sidecar。

## 前置条件

1. web-access 浏览器 sidecar 已启动
2. 小红书创作者平台已登录（登录态持久化在 `.data/chrome-sidecar`）
3. 手机号已绑定

**检查**：
```bash
curl -s http://127.0.0.1:3456/health
docker ps | grep ugk-pi-browser
```

---

## 场景触发地图

| 用户说... | 你要... | 参考文档 |
|-----------|---------|----------|
| "小红书搜一下 XX" / "搜索 XX" / "XX 有什么推荐" / "帮我找找 XX 的内容" / "小红书上有哪些 XX" / "XX 攻略" / "整理 XX 的资料" | 执行标准检索 → 读取报告 → 整理总结发给用户 | → [docs/search.md](docs/search.md) |
| "发一篇笔记" / "帮我写个小红书" / "文字配图发帖" | 文字配图发布（AI 生成配图） | → [docs/publish-text2image.md](docs/publish-text2image.md) |
| "我有图片要发" / "上传图片发帖" | 图片上传发布 | → [docs/publish-images.md](docs/publish-images.md) |
| "看我发了什么" / "获取笔记数据" / "笔记列表" | 获取创作者平台笔记列表 | → [docs/notes.md](docs/notes.md) |

---

## 通用注意事项

### 平台限制

| 限制项 | 上限 |
|--------|------|
| 每张图正文 | 500字 |
| 标题 | 20字 |
| 单张最佳字数 | ≤108字 / ≤12行 |

### 已发布记录

```bash
python3 scripts/publish-note.py --list
python3 scripts/publish-note.py --check --title "标题关键词"
```

### 浏览器页面清理

```bash
# 按 scope 清理
curl -s -X POST "http://127.0.0.1:3456/session/close-all?metaAgentScope=xhs-publish"

# 清理所有（慎用）
curl -s -X POST "http://127.0.0.1:3456/session/close-all"
```

### 错误处理

```bash
# 检查编辑器是否找到
curl -s -X POST "http://127.0.0.1:3456/eval?..." -d '...' | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error', 'ok'))"

# 检查发布结果
curl -s -X POST "http://127.0.0.1:3456/eval?..." -d '(() => ({ published: window.location.href.includes("published=true") }))()'
```

### 性能参考

| 操作 | 建议等待 |
|------|----------|
| 页面加载 | 8秒 |
| 编辑器加载 | 轮询检测 2-4秒 |
| AI 图片生成 | 30秒 |
| 模式切换 | 5秒 |
