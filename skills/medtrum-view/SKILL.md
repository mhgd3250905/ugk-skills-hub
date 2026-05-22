---
name: medtrum-view
description: 仅当用户显式输入 /medtrum-view 时使用。读取共享 SQLite 数据库，生成跨平台舆情监控静态 HTML 页面，固定 URL 可直接访问。
allowed-tools: Bash
---

# Medtrum View — 舆情数据浏览

## 触发方式
- 显式命令：`/medtrum-view`
- Spider 自动刷新：直接运行生成脚本

## 访问地址

页面写入 `$ARTIFACT_PUBLIC_DIR/medtrum-view/index.html`，浏览地址为：

```
$ARTIFACT_PUBLIC_BASE_URL/medtrum-view/index.html
```

Spider 写入新数据后刷新页面即可。不要硬编码公网 IP 或 `/v1/local-file?path=...`。

## 任务

```bash
python3 /app/runtime/skills-user/medtrum-view/generate.py
```

## 输出
- `$ARTIFACT_PUBLIC_DIR/medtrum-view/index.html` — 静态 HTML 页面

## 关键原则
- 每次调用重新生成，刷新页面即最新数据
- 固定 URL，无需重新获取
- SQLite 只读查询，不修改数据
