---
name: send-email
description: 发送邮件工具。当用户要求发送邮件、发邮件、邮件通知、邮件报告时触发。支持文本和 HTML 格式邮件，支持附件。触发词：发邮件、发送邮件、邮件发送、email、通知邮件。
user-invocable: true
allowed-tools: "Read, Write, Edit, Bash"
---

# 邮件发送 Skill

通过 SMTP 发送邮件，支持文本、HTML 格式和附件。

## 功能

- 发送文本 / HTML 格式邮件
- 支持附件
- 支持抄送 / 密送
- 使用 skill 目录下的 `config.json` 读取 SMTP 配置

## 配置文件

先在 skill 根目录创建：

```text
runtime/skills-user/send-email/config.json
```

可直接复制模板：

```bash
cp runtime/skills-user/send-email/config.example.json runtime/skills-user/send-email/config.json
```

模板内容如下：

```json
{
  "smtp": {
    "server": "smtp.qq.com",
    "port": 465,
    "sender_email": "your-email@example.com",
    "sender_password": "your-smtp-password",
    "sender_name": "UGK Assistant",
    "security_mode": "ssl"
  },
  "default_recipients": []
}
```

`config.json` 是私有配置，不应提交到仓库。

## 使用方式

### 方式一：自然语言

```text
发邮件给 xxx@qq.com，主题是"报告"，内容是"这是报告内容"
```

```text
把这份报告发送到 xxx@qq.com
```

### 方式二：命令行（Node.js 版本，推荐）

```bash
node runtime/skills-user/send-email/scripts/email_sender.mjs \
  -t "收件人@qq.com" \
  -s "邮件主题" \
  -b "邮件正文"
```

如果需要显式指定配置文件：

```bash
node runtime/skills-user/send-email/scripts/email_sender.mjs \
  --config runtime/skills-user/send-email/config.json \
  -t "收件人@qq.com" \
  -s "邮件主题" \
  -b "邮件正文"
```

### 方式三：命令行（Python 版本）

如果环境有 Python：

```bash
python3 runtime/skills-user/send-email/scripts/email_sender.py \
  -t "收件人@qq.com" \
  -s "邮件主题" \
  -b "邮件正文"
```

## 参数说明

| 参数 | 说明 | 必需 |
|:--|:--|:--|
| `-t, --to` | 收件人邮箱，多个用逗号分隔 | 是 |
| `-s, --subject` | 邮件主题 | 是 |
| `-b, --body` | 邮件正文 | 是 |
| `--html` | 正文为 HTML 格式 | 否 |
| `-a, --attach` | 附件路径，多个用逗号分隔 | 否 |
| `-c, --cc` | 抄送，多个用逗号分隔 | 否 |
| `--bcc` | 密送，多个用逗号分隔 | 否 |

## 示例

### 发送简单邮件

```bash
node runtime/skills-user/send-email/scripts/email_sender.mjs \
  -t "recipient@example.com" \
  -s "测试邮件" \
  -b "这是测试内容"
```

### 发送 HTML 邮件

```bash
node runtime/skills-user/send-email/scripts/email_sender.mjs \
  -t "recipient@example.com" \
  -s "HTML 邮件" \
  -b "<h1>标题</h1><p>内容</p>" \
  --html
```

### 发送带附件的邮件

```bash
node runtime/skills-user/send-email/scripts/email_sender.mjs \
  -t "recipient@example.com" \
  -s "报告" \
  -b "请查收附件" \
  -a "/path/to/report.pdf"
```

## 执行流程

1. 调用脚本发送邮件
2. 检查返回结果
3. 成功则告知用户已发送成功
4. 失败则分析原因并尝试修复
5. 修复后重试
6. 无法修复时返回明确错误信息

## 常见错误

| 错误类型 | 处理方式 |
|:--|:--|
| 认证失败 | 检查 SMTP 授权码 / 密码 |
| 附件不存在 | 检查文件路径 |
| 网络超时 | 重试发送 |
| SMTP 连接失败 | 检查服务器地址、端口和安全模式 |

## 注意事项

1. QQ 邮箱通常需要使用 SMTP 授权码，而不是登录密码
2. 发件人名称会显示在收件人的邮件客户端中
3. 附件支持中文文件名
4. 大附件发送可能较慢