#!/usr/bin/env python3

import json
import sys
import unittest
from pathlib import Path
import shutil

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from email_sender import load_config


class LoadConfigTest(unittest.TestCase):
    def test_load_config_raises_when_file_missing(self):
        work_dir = Path(__file__).resolve().parent / ".tmp-tests"
        work_dir.mkdir(exist_ok=True)
        missing_path = work_dir / "missing-send-email-config.json"
        if missing_path.exists():
            missing_path.unlink()

        with self.assertRaisesRegex(RuntimeError, "config.json|Config file not found"):
            load_config(missing_path)

    def test_load_config_reads_json_file(self):
        work_dir = Path(__file__).resolve().parent / ".tmp-tests" / "load-config"
        if work_dir.exists():
            shutil.rmtree(work_dir)
        work_dir.mkdir(parents=True, exist_ok=True)

        try:
            config_path = work_dir / "config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "smtp": {
                            "server": "smtp.example.com",
                            "port": 465,
                            "sender_email": "bot@example.com",
                            "sender_password": "secret",
                            "sender_name": "Mailer",
                            "security_mode": "ssl",
                        },
                        "default_recipients": ["ops@example.com"],
                    }
                ),
                encoding="utf-8",
            )

            loaded = load_config(config_path)

            self.assertEqual(loaded["smtp"]["server"], "smtp.example.com")
            self.assertEqual(loaded["smtp"]["sender_email"], "bot@example.com")
            self.assertEqual(loaded["default_recipients"], ["ops@example.com"])
        finally:
            if work_dir.exists():
                shutil.rmtree(work_dir)


if __name__ == "__main__":
    unittest.main()
