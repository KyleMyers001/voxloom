#!/usr/bin/env python3
"""Exercise bounded cleanup errors without weights; never inference evidence."""

import json
import struct
import subprocess
import sys

MAX_FRAME_BYTES = 128 * 1024


def check(worker, request, request_id, code):
    frame = struct.pack(">I", len(request)) + request
    process = subprocess.run(
        [worker], check=False, input=frame, stderr=subprocess.PIPE,
        stdout=subprocess.PIPE, timeout=10,
    )
    if process.returncode != 1 or process.stderr:
        raise SystemExit("worker did not fail quietly with exit 1")
    if len(process.stdout) < 4:
        raise SystemExit("worker returned no framed response")
    size = struct.unpack(">I", process.stdout[:4])[0]
    if size == 0 or size > MAX_FRAME_BYTES:
        raise SystemExit("worker returned invalid frame size")
    body = process.stdout[4:]
    if len(body) != size:
        raise SystemExit("worker returned an incomplete or extra frame")
    try:
        response = json.loads(body)
    except (ValueError, UnicodeError):
        raise SystemExit("worker returned invalid JSON") from None
    if not isinstance(response, dict) or response.get("requestId") != request_id:
        raise SystemExit("worker returned a mismatched request ID")
    diagnostic = response.get("error")
    if (response.get("status") != "error" or response.get("errorCode") != code
            or response.get("text") is not None or not isinstance(diagnostic, str)
            or not 0 < len(diagnostic.encode("utf-8")) <= 1024
            or "synthetic-private-marker" in diagnostic):
        raise SystemExit("worker did not return a bounded intentional error")


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: smoke-cleanup-worker.py WORKER")
    worker = sys.argv[1]
    request = json.dumps({
        "modelPath": "/definitely/missing/model.gguf",
        "prompt": "protocol smoke",
        "requestId": "protocol-smoke",
    }).encode()
    check(worker, request, "protocol-smoke", "model-missing")
    check(worker, b'{"prompt":"synthetic-private-marker",', "", "runtime-error")
    check(worker, json.dumps({"requestId": "x" * 129}).encode(), "", "runtime-error")
    check(worker, b'{"requestId":"\x80"}', "", "runtime-error")
    print("cleanup worker protocol smoke: 4 cases passed (no weights)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
