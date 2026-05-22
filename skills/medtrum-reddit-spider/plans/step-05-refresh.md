# Step 05：刷新浏览页面（终点）

## 输入
无（直接读取 SQLite 生成）

## 任务

按 medtrum-view 技能规范刷新页面。`generate.py` 使用 `$ARTIFACT_PUBLIC_DIR` / `$ARTIFACT_PUBLIC_BASE_URL` 环境变量，平台自动注入：

```bash
python3 /app/runtime/skills-user/medtrum-view/generate.py
```

## 输出
`$ARTIFACT_PUBLIC_DIR/medtrum-view/index.html` — 更新的静态页面（含下载按钮指向最新 PDF）

## 验证命令
```bash
F="$ARTIFACT_PUBLIC_DIR/medtrum-view/index.html"
[ -s "$F" ] && echo "PASS: step-05 ($(wc -c < "$F") bytes)" || echo "FAIL: missing"
```

## 验证失败处理
重试最多 1 次。仍失败汇报"页面刷新失败，数据已入库，稍后可手动刷新"。

## 下一步
`TERMINAL` — 流水线结束。输出最终汇报。
