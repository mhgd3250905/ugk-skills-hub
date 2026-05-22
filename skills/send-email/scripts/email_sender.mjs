#!/usr/bin/env node
/**
 * SMTP email sender with support for plain text, HTML, CC/BCC, and attachments.
 * Node.js version for environments without Python.
 */

import nodemailer from 'nodemailer';
import { readFileSync, existsSync, statSync } from 'fs';
import { basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_CONFIG_PATH = resolve(__dirname, '..', 'config.json');

function loadConfig(configPath) {
  const resolvedPath = configPath || DEFAULT_CONFIG_PATH;
  if (!existsSync(resolvedPath)) {
    throw new Error(`Config file not found: ${resolvedPath}`);
  }

  const config = JSON.parse(readFileSync(resolvedPath, 'utf-8'));
  const smtp = config.smtp || {};

  const requiredFields = ['server', 'port', 'sender_email', 'sender_password', 'sender_name', 'security_mode'];
  const missing = requiredFields.filter(f => !smtp[f]);
  if (missing.length > 0) {
    throw new Error(`Missing required SMTP config fields: ${missing.join(', ')}`);
  }

  return {
    smtp,
    default_recipients: config.default_recipients || []
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    config: null,
    to: null,
    subject: null,
    body: null,
    html: false,
    attach: null,
    cc: null,
    bcc: null
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--config':
        result.config = args[++i];
        break;
      case '-t':
      case '--to':
        result.to = args[++i];
        break;
      case '-s':
      case '--subject':
        result.subject = args[++i];
        break;
      case '-b':
      case '--body':
        result.body = args[++i];
        break;
      case '--html':
        result.html = true;
        break;
      case '-a':
      case '--attach':
        result.attach = args[++i];
        break;
      case '-c':
      case '--cc':
        result.cc = args[++i];
        break;
      case '--bcc':
        result.bcc = args[++i];
        break;
    }
  }

  return result;
}

async function main() {
  const args = parseArgs();

  if (!args.to || !args.subject || !args.body) {
    console.error('Usage: email_sender.mjs -t <to> -s <subject> -b <body> [--html] [-a <attachments>] [-c <cc>] [--bcc <bcc>] [--config <path>]');
    process.exit(1);
  }

  try {
    const config = loadConfig(args.config);
    const smtp = config.smtp;

    const toEmails = args.to.split(',').map(e => e.trim()).filter(Boolean);
    const ccEmails = args.cc ? args.cc.split(',').map(e => e.trim()).filter(Boolean) : [];
    const bccEmails = args.bcc ? args.bcc.split(',').map(e => e.trim()).filter(Boolean) : [];
    const attachments = args.attach ? args.attach.split(',').map(p => p.trim()).filter(Boolean) : [];

    // Verify attachment files exist
    for (const filePath of attachments) {
      if (!existsSync(filePath)) {
        console.error(`Attachment not found: ${filePath}`);
        process.exit(1);
      }
    }

    const transporter = nodemailer.createTransport({
      host: smtp.server,
      port: smtp.port,
      secure: smtp.security_mode.toLowerCase() === 'ssl',
      auth: {
        user: smtp.sender_email,
        pass: smtp.sender_password
      }
    });

    const mailOptions = {
      from: `"${smtp.sender_name}" <${smtp.sender_email}>`,
      to: toEmails.join(', '),
      subject: args.subject,
      [args.html ? 'html' : 'text']: args.body
    };

    if (ccEmails.length > 0) {
      mailOptions.cc = ccEmails.join(', ');
    }
    if (bccEmails.length > 0) {
      mailOptions.bcc = bccEmails.join(', ');
    }
    if (attachments.length > 0) {
      mailOptions.attachments = attachments.map(path => ({
        filename: basename(path),
        path: path
      }));
    }

    const info = await transporter.sendMail(mailOptions);
    const allRecipients = [...toEmails, ...ccEmails, ...bccEmails];
    console.log(`Email sent successfully to: ${allRecipients.join(', ')}`);
    console.log(`Message ID: ${info.messageId}`);
    process.exit(0);
  } catch (err) {
    console.error(`Send failed: ${err.message}`);
    process.exit(1);
  }
}

main();