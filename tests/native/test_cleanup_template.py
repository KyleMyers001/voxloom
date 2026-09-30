"""Template runner tests use tiny synthetic files/checkers, never model weights."""

import hashlib
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import cleanup_model  # noqa: E402

spec = importlib.util.spec_from_file_location(
    "template_check", ROOT / "scripts/check-cleanup-template.py")
template_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(template_check)


class CleanupTemplateTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix="voxloom-template-")
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.model = self.root / "fixture.gguf"
        self.model.write_bytes(b"GGUFtest")
        self.pin = cleanup_model.Artifact(
            "synthetic", 8, hashlib.sha256(b"GGUFtest").hexdigest())

    def test_pin_matches_native_identity(self):
        import re
        source = (ROOT / "src-tauri/src/cleanup/model_store.rs").read_text()
        pin = cleanup_model.PIN
        self.assertEqual(pin.model_id, re.search(
            r'MODEL_ID: &str = "([^"]+)"', source)[1])
        self.assertEqual(pin.sha256, re.search(
            r'MODEL_SHA256: &str =\s*"([^"]+)"', source)[1])
        self.assertEqual(pin.size, int(re.search(
            r'MODEL_SIZE: u64 = ([\d_]+)', source)[1].replace('_', '')))

    def test_holds_verified_descriptor_across_path_replacement(self):
        with cleanup_model.verified_model(self.model, self.pin) as fd:
            self.model.rename(self.root / "original")
            self.model.write_bytes(b"BAD!test")
            self.assertEqual(os.read(fd, 8), b"GGUFtest")
        with self.assertRaises(OSError):
            os.fstat(fd)

    def test_rejects_symlinks_nonregular_and_same_size_tampering(self):
        link = self.root / "link"
        link.symlink_to(self.model)
        pipe = self.root / "pipe"
        os.mkfifo(pipe)
        for path in (link, pipe, self.root):
            with self.subTest(path=path.name), self.assertRaises((OSError, ValueError)):
                with cleanup_model.verified_model(path, self.pin):
                    self.fail("invalid model accepted")
        self.model.write_bytes(b"GGUFfake")
        with self.assertRaises(ValueError):
            with cleanup_model.verified_model(self.model, self.pin):
                self.fail("tampering accepted")

    def test_runner_inherits_descriptor_and_reports_actual_checker_result(self):
        checker = self.root / "checker"
        checker.write_text(
            '#!/usr/bin/env python3\nimport sys\n'
            'assert sys.argv[1] == "--model"\n'
            'assert open(sys.argv[2], "rb").read() == b"GGUFtest"\n')
        checker.chmod(0o700)
        self.assertEqual(template_check.check(checker, self.model, self.pin), 0)
        checker.write_text('#!/usr/bin/env python3\nraise SystemExit(7)\n')
        self.assertEqual(template_check.check(checker, self.model, self.pin), 7)


if __name__ == "__main__":
    unittest.main()
