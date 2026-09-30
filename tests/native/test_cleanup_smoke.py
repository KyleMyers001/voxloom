"""Smoke-harness regressions. Fake workers are not real model evidence."""

from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class CleanupSmokeTests(unittest.TestCase):
    def run_smoke(self, *, code="model-missing", stderr="", status=1):
        with tempfile.TemporaryDirectory(prefix="voxloom-smoke-") as scratch:
            worker = Path(scratch) / "worker"
            worker.write_text(
                '#!/usr/bin/env python3\nimport json, struct, sys\n'
                'data = sys.stdin.buffer.read()\n'
                'try:\n'
                ' req = json.loads(data[4:])\n'
                ' rid = req.get("requestId", "")\n'
                ' valid = isinstance(rid, str) and 0 < len(rid.encode()) <= 128\n'
                'except (ValueError, AttributeError):\n'
                ' rid, valid = "", False\n'
                f'code = {code!r} if valid else "runtime-error"\n'
                'body = json.dumps({"requestId": rid if valid else "",\n'
                ' "status": "error", "errorCode": code, "error": "fixed",\n'
                ' "text": None}).encode()\n'
                'sys.stdout.buffer.write(struct.pack(">I", len(body)) + body)\n'
                f'sys.stderr.write({stderr!r})\nraise SystemExit({status})\n')
            worker.chmod(0o700)
            return subprocess.run(
                ["python3", str(ROOT / "scripts/smoke-cleanup-worker.py"), str(worker)],
                check=False, capture_output=True, timeout=10,
            )

    def test_accepts_fixed_missing_model_and_startup_errors(self):
        result = self.run_smoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"4 cases", result.stdout)

    def test_rejects_unknown_code_log_leaks_and_success_exit(self):
        for kwargs in ({"code": "runtime-error"}, {"stderr": "private"}, {"status": 0}):
            with self.subTest(kwargs=kwargs):
                self.assertNotEqual(self.run_smoke(**kwargs).returncode, 0)


if __name__ == "__main__":
    unittest.main()
