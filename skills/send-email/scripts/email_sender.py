#!/usr/bin/env python3
"""
SMTP email sender with support for plain text, HTML, CC/BCC, and attachments.
"""

from __future__ import annotations

import argparse
import json
import os
import smtplib
from email import encoders
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from pathlib import Path
from typing import Optional

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG_PATH = SCRIPT_DIR.parent / "config.json"
EXAMPLE_CONFIG_PATH = SCRIPT_DIR.parent / "config.example.json"
REQUIRED_SMTP_FIELDS = (
    "server",
    "port",
    "sender_email",
    "sender_password",
    "sender_name",
    "security_mode",
)


def load_config(config_path: Optional[Path] = None) -> dict:
    """Load SMTP config from the skill-local config file."""
    resolved_path = Path(config_path) if config_path else DEFAULT_CONFIG_PATH
    if not resolved_path.exists():
        raise RuntimeError(
            f"Config file not found: {resolved_path}. "
            f"Create config.json from {EXAMPLE_CONFIG_PATH.name} first."
        )

    with resolved_path.open("r", encoding="utf-8") as file:
        config = json.load(file)

    smtp_config = config.get("smtp") or {}
    missing_fields = [
        field for field in REQUIRED_SMTP_FIELDS
        if not str(smtp_config.get(field, "")).strip()
    ]
    if missing_fields:
        raise RuntimeError(
            "Missing required SMTP config fields: " + ", ".join(missing_fields)
        )

    config.setdefault("default_recipients", [])
    return config


class EmailSender:
    """Thin SMTP sender wrapper used by the skill script."""

    def __init__(self, config: Optional[dict] = None, config_path: Optional[Path] = None):
        self.config = config or load_config(config_path)
        self.smtp_config = self.config.get("smtp", {})

    def send(
        self,
        to_emails: list[str],
        subject: str,
        body: str,
        body_type: str = "plain",
        attachments: Optional[list[str]] = None,
        cc: Optional[list[str]] = None,
        bcc: Optional[list[str]] = None,
    ) -> dict:
        try:
            msg = MIMEMultipart()
            sender_name = self.smtp_config["sender_name"]
            sender_email = self.smtp_config["sender_email"]
            password = self.smtp_config["sender_password"]
            server = self.smtp_config["server"]
            port = self.smtp_config["port"]

            msg["From"] = formataddr((sender_name, sender_email))
            msg["To"] = ", ".join(to_emails)
            msg["Subject"] = subject

            all_recipients = list(to_emails)
            if cc:
                msg["Cc"] = ", ".join(cc)
                all_recipients.extend(cc)
            if bcc:
                all_recipients.extend(bcc)

            msg.attach(MIMEText(body, body_type, "utf-8"))

            if attachments:
                for file_path in attachments:
                    if not os.path.exists(file_path):
                        return {"success": False, "message": f"Attachment not found: {file_path}"}

                    with open(file_path, "rb") as file:
                        part = MIMEBase("application", "octet-stream")
                        part.set_payload(file.read())
                        encoders.encode_base64(part)
                        filename = os.path.basename(file_path)
                        part.add_header(
                            "Content-Disposition",
                            "attachment",
                            filename=("utf-8", "", filename),
                        )
                        msg.attach(part)

            security_mode = str(self.smtp_config.get("security_mode", "")).lower()
            if security_mode == "ssl":
                with smtplib.SMTP_SSL(server, port) as smtp:
                    smtp.login(sender_email, password)
                    smtp.sendmail(sender_email, all_recipients, msg.as_string())
            else:
                with smtplib.SMTP(server, port) as smtp:
                    smtp.starttls()
                    smtp.login(sender_email, password)
                    smtp.sendmail(sender_email, all_recipients, msg.as_string())

            return {
                "success": True,
                "message": f"Email sent successfully to: {', '.join(all_recipients)}",
            }
        except Exception as exc:
            return {"success": False, "message": f"Send failed: {exc}"}


def main() -> int:
    parser = argparse.ArgumentParser(description="SMTP email sender")
    parser.add_argument(
        "--config",
        help="Path to config file. Defaults to config.json in the skill root.",
    )
    parser.add_argument("-t", "--to", required=True, help="Recipient email list separated by commas")
    parser.add_argument("-s", "--subject", required=True, help="Email subject")
    parser.add_argument("-b", "--body", required=True, help="Email body")
    parser.add_argument("--html", action="store_true", help="Treat body as HTML")
    parser.add_argument("-a", "--attach", help="Attachment paths separated by commas")
    parser.add_argument("-c", "--cc", help="CC email list separated by commas")
    parser.add_argument("--bcc", help="BCC email list separated by commas")
    args = parser.parse_args()

    to_emails = [email.strip() for email in args.to.split(",") if email.strip()]
    body_type = "html" if args.html else "plain"
    attachments = [path.strip() for path in args.attach.split(",") if path.strip()] if args.attach else None
    cc = [email.strip() for email in args.cc.split(",") if email.strip()] if args.cc else None
    bcc = [email.strip() for email in args.bcc.split(",") if email.strip()] if args.bcc else None
    config_path = Path(args.config).expanduser() if args.config else None

    try:
        sender = EmailSender(config_path=config_path)
    except RuntimeError as exc:
        print(f"Send failed: {exc}")
        return 1

    result = sender.send(
        to_emails=to_emails,
        subject=args.subject,
        body=args.body,
        body_type=body_type,
        attachments=attachments,
        cc=cc,
        bcc=bcc,
    )
    print(result["message"])
    return 0 if result["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())