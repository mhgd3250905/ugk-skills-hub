#!/bin/bash
# GitHub Helper 技能 - gh CLI 安装与配置脚本
# 确保 gh CLI 可用，并配置认证

set -e

SKILL_DIR="/app/runtime/skills-user/github-helper"
BUNDLED_GH="$SKILL_DIR/bin/gh"
SYSTEM_GH="/usr/local/bin/gh"

echo "=== GitHub Helper 技能设置 ==="

# 1. 检查或安装 gh CLI
if ! command -v gh &> /dev/null; then
    echo "gh 未安装，正在配置..."
    if [ -f "$BUNDLED_GH" ]; then
        echo "使用技能内置的 gh..."
        cp "$BUNDLED_GH" "$SYSTEM_GH"
        chmod +x "$SYSTEM_GH"
        echo "✓ gh 已安装"
    else
        echo "错误：未找到内置 gh 二进制文件"
        echo "请从 https://github.com/cli/cli/releases 手动安装"
        exit 1
    fi
else
    echo "✓ gh 已安装"
fi

# 2. 验证 gh 版本
echo ""
echo "gh 版本信息："
gh --version

# 3. 配置认证（如果提供了 GITHUB_TOKEN）
if [ -n "$GITHUB_TOKEN" ]; then
    echo ""
    echo "检测到 GITHUB_TOKEN，正在配置认证..."
    echo "$GITHUB_TOKEN" | gh auth login --with-token
    echo "✓ 认证已配置"
else
    echo ""
    echo "提示：设置 GITHUB_TOKEN 环境变量以启用认证"
    echo "  export GITHUB_TOKEN='ghp_xxxxxxxxxxxx'"
    echo "  或运行：gh auth login"
fi

# 4. 验证认证状态
echo ""
echo "认证状态："
gh auth status || echo "未认证（公开仓库仍可访问，但限流更严格）"

echo ""
echo "=== 设置完成 ==="
echo "你现在可以使用 GitHub Helper 技能了！"
