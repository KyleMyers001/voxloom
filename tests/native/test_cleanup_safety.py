"""Compile/run the worker's dependency-free safety checks; no model/source fetch."""

from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class CleanupSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scratch = tempfile.TemporaryDirectory(prefix="voxloom-safety-")
        cls.addClassCleanup(cls.scratch.cleanup)
        cls.binary = Path(cls.scratch.name) / "safety-check"
        subprocess.run([
            "c++", "-std=c++17", "-Wall", "-Wextra", "-Werror", "-DNDEBUG",
            str(ROOT / "native/cleanup-worker/safety_check.cpp"),
            "-o", str(cls.binary),
        ], check=True, capture_output=True, timeout=60)

    def run_check(self, *args):
        return subprocess.run([str(self.binary), *args], capture_output=True,
                              check=False, timeout=5)

    def test_utf8_bounds_and_fixed_errors(self):
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"cleanup safety checks passed", result.stdout)

    def test_backend_stderr_is_suppressed(self):
        result = self.run_check("--quiet")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, b"")

    def test_backend_stdout_is_suppressed_and_protocol_stdout_restored(self):
        result = self.run_check("--quiet-stdout")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"restored\n")

    def test_missing_and_nonregular_models_fail_without_blocking(self):
        root = Path(self.scratch.name)
        import os
        fifo = root / "pipe"
        os.mkfifo(fifo)
        for path in (root / "missing", root, fifo):
            with self.subTest(path=path.name):
                result = self.run_check("--model", str(path))
                self.assertEqual(result.returncode, 1)
                self.assertTrue(result.stderr.startswith(b"model-missing:"))
                self.assertNotIn(str(path).encode(), result.stderr)

    def test_regular_descriptor_requires_gguf_magic(self):
        path = Path(self.scratch.name) / "synthetic.gguf"
        path.write_bytes(b"BAD!test")
        self.assertEqual(self.run_check("--model", str(path)).returncode, 1)
        path.write_bytes(b"GGUFtest")
        self.assertEqual(self.run_check("--model", str(path)).returncode, 0)


if __name__ == "__main__":
    unittest.main()
