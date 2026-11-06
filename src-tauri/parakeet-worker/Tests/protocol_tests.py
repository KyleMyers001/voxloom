"""Black-box framed-stdio tests. Build the fixture first; never uses weights."""
import json
import os
from pathlib import Path
import select
import struct
import subprocess
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = Path(os.environ.get("PARAKEET_FIXTURE", ROOT / ".build/debug/parakeet-worker-fixture"))


def frame(value):
    data = json.dumps(value, separators=(",", ":")).encode()
    return struct.pack("<I", len(data)) + data


def load(version="v2"):
    return {"protocolVersion": 1, "op": "load", "requestId": "job-1", "modelVersion": version, "modelDirectory": "/mock/local"}


def audio(count=3):
    return {"protocolVersion": 1, "op": "transcribe", "requestId": "job-1", "sampleRateHz": 16000, "sampleCount": count}


class ProtocolTests(unittest.TestCase):
    def remaining(self, stream):
        assert stream is not None
        return stream.read()

    def spawn(self, *args, binary=FIXTURE):
        process = subprocess.Popen([str(binary), *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        def cleanup():
            if process.poll() is None:
                process.kill()
            process.wait(timeout=3)
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    stream.close()
        self.addCleanup(cleanup)
        return process

    def exact(self, process, count, timeout=3):
        data = b""
        deadline = time.monotonic() + timeout
        while len(data) < count:
            ready = select.select([process.stdout], [], [], max(0, deadline - time.monotonic()))[0]
            self.assertTrue(ready, "worker reply timed out")
            part = os.read(process.stdout.fileno(), count - len(data))
            self.assertTrue(part, "worker exited before complete reply")
            data += part
        return data

    def reply(self, process):
        length = struct.unpack("<I", self.exact(process, 4))[0]
        self.assertTrue(0 < length <= 65536)
        return json.loads(self.exact(process, length))

    def send(self, process, data):
        process.stdin.write(data)
        process.stdin.flush()

    def signal(self, process, expected):
        self.assertTrue(select.select([process.stderr], [], [], 3)[0], "fixture phase not reached")
        self.assertEqual(os.read(process.stderr.fileno(), 128), expected)

    def assert_exits_on_eof(self, process):
        start = time.monotonic()
        process.stdin.close()
        try:
            process.wait(timeout=1.5)
        except subprocess.TimeoutExpired:
            self.fail("parent EOF did not terminate worker within 1.5s")
        self.assertLess(time.monotonic() - start, 1.5)
        self.assertEqual(self.remaining(process.stdout), b"")

    def test_parent_eof_interrupts_synchronous_load_started_before_pcm(self):
        process = self.spawn("load-delay")
        self.send(process, frame(load()))
        self.signal(process, b"loading\n")
        self.assert_exits_on_eof(process)

    def test_parent_eof_interrupts_synchronous_inference(self):
        process = self.spawn("inference-delay")
        self.send(process, frame(load()))
        self.assertEqual(self.reply(process)["op"], "ready")
        self.send(process, frame(audio()) + struct.pack("<fff", -1, 0, 1))
        self.signal(process, b"inference\n")
        self.assert_exits_on_eof(process)

    def test_parent_eof_while_awaiting_audio_header(self):
        process = self.spawn()
        self.send(process, frame(load()))
        self.assertEqual(self.reply(process)["op"], "ready")
        self.assert_exits_on_eof(process)

    def test_parent_eof_while_reading_partial_pcm(self):
        process = self.spawn()
        self.send(process, frame(load()))
        self.assertEqual(self.reply(process)["op"], "ready")
        self.send(process, frame(audio()) + b"\x00")
        self.assert_exits_on_eof(process)

    def test_write_deadline_terminates_blocked_protocol_pipe(self):
        process = self.spawn("deadline-write")
        self.signal(process, b"blocked-output\n")
        self.send(process, frame(load()))
        self.assertEqual(process.wait(timeout=1.5), 1)

    def test_deadline_terminates_missing_initial_header(self):
        process = self.spawn("deadline")
        self.assertEqual(process.wait(timeout=1.5), 1)

    def test_deadline_terminates_blocked_load(self):
        process = self.spawn("deadline-load")
        self.send(process, frame(load()))
        self.signal(process, b"loading\n")
        self.assertEqual(process.wait(timeout=1.5), 1)

    def test_deadline_terminates_missing_pcm(self):
        process = self.spawn("deadline")
        self.send(process, frame(load()))
        self.assertEqual(self.reply(process)["op"], "ready")
        self.assertEqual(process.wait(timeout=1.5), 1)

    def test_deadline_terminates_blocked_inference(self):
        process = self.spawn("deadline-inference")
        self.send(process, frame(load()))
        self.assertEqual(self.reply(process)["op"], "ready")
        self.send(process, frame(audio()) + struct.pack("<fff", -1, 0, 1))
        self.signal(process, b"inference\n")
        self.assertEqual(process.wait(timeout=1.5), 1)

    def test_real_executable_reports_missing_local_models_for_both_versions(self):
        binary = Path(os.environ.get("PARAKEET_WORKER", ROOT / ".build/debug/voxloom-parakeet-worker"))
        for version in ("v2", "v3"):
            with self.subTest(version=version):
                process = self.spawn(binary=binary)
                header = load(version)
                header["modelDirectory"] = "/voxloom-test-never-provisioned-571c0c1c"
                self.send(process, frame(header))
                reply = self.reply(process)
                self.assertEqual(reply["op"], "error")
                self.assertEqual(reply["code"], "model-missing")
                self.assertEqual(reply["requestId"], "job-1")
                self.assertNotIn(header["modelDirectory"], json.dumps(reply))
                self.assertLess(len(reply["message"]), 128)
                self.assertEqual(process.wait(timeout=3), 0)
                self.assertEqual(self.remaining(process.stderr), b"")

    def test_dependency_console_output_cannot_corrupt_wire_or_leak_paths(self):
        process = self.spawn("noisy")
        self.send(process, frame(load()))
        self.assertEqual(self.reply(process)["op"], "ready")
        self.send(process, frame(audio()) + struct.pack("<fff", -1, 0, 1))
        self.assertEqual(self.reply(process)["op"], "result")
        self.assertEqual(process.wait(timeout=3), 0)
        self.assertEqual(self.remaining(process.stdout), b"")
        self.assertEqual(self.remaining(process.stderr), b"")

    def test_rejects_oversized_control_length_without_waiting_for_body(self):
        for length in (0, 65537, 0xFFFFFFFF):
            with self.subTest(length=length):
                process = self.spawn()
                self.send(process, struct.pack("<I", length))
                reply = self.reply(process)
                self.assertEqual(reply["op"], "error")
                self.assertEqual(reply["code"], "engine-unavailable")
                self.assertEqual(process.wait(timeout=3), 0)

    def test_rejects_mismatched_or_oversized_audio_header_without_waiting_for_pcm(self):
        for field, value in (("requestId", "other"), ("sampleCount", 1920001), ("sampleCount", -1), ("sampleRateHz", 48000), ("op", "load"), ("protocolVersion", 2)):
            with self.subTest(field=field, value=value):
                process = self.spawn()
                self.send(process, frame(load()))
                self.assertEqual(self.reply(process)["op"], "ready")
                header = audio()
                header[field] = value
                self.send(process, frame(header))
                reply = self.reply(process)
                self.assertEqual(reply["op"], "error")
                self.assertEqual(reply["code"], "unsupported-audio")
                self.assertEqual(reply["requestId"], "job-1")
                self.assertEqual(process.wait(timeout=3), 0)

    def test_rejects_nonfinite_or_out_of_range_pcm_before_inference(self):
        for value in (float("nan"), float("inf"), -float("inf"), 1.1, -1.1):
            with self.subTest(value=value):
                process = self.spawn("inference-delay")
                self.send(process, frame(load()))
                self.assertEqual(self.reply(process)["op"], "ready")
                self.send(process, frame(audio(1)) + struct.pack("<f", value))
                reply = self.reply(process)
                self.assertEqual(reply["code"], "unsupported-audio")
                self.assertEqual(process.wait(timeout=3), 0)
                self.assertEqual(self.remaining(process.stderr), b"")  # no inference phase

    def test_fragmented_headers_and_pcm_are_reassembled(self):
        process = self.spawn()
        for byte in frame(load()):
            self.send(process, bytes([byte]))
        self.assertEqual(self.reply(process)["op"], "ready")
        for byte in frame(audio()) + struct.pack("<fff", -1, 0, 1):
            self.send(process, bytes([byte]))
        self.assertEqual(self.reply(process)["op"], "result")
        self.assertEqual(process.wait(timeout=3), 0)

    def test_fresh_process_handles_both_versions_then_exits(self):
        for version in ("v2", "v3"):
            with self.subTest(version=version):
                process = self.spawn()
                self.send(process, frame(load(version)))
                self.assertEqual(self.reply(process), {"protocolVersion": 1, "op": "ready", "requestId": "job-1"})
                self.send(process, frame(audio()) + struct.pack("<fff", -1, 0, 1))
                self.assertEqual(self.reply(process), {"protocolVersion": 1, "op": "result", "requestId": "job-1", "text": "fixture transcript", "rawText": "fixture transcript", "language": "en" if version == "v2" else None, "dropped": None})
                self.assertEqual(process.wait(timeout=3), 0)
                self.assertEqual(self.remaining(process.stdout), b"")
                self.assertEqual(self.remaining(process.stderr), b"")


if __name__ == "__main__":
    unittest.main(verbosity=2)
