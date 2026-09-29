#!/usr/bin/env python3
"""Exercise the cleanup worker's framed protocol without model weights."""

import json
import struct
import subprocess
import sys

MAX_FRAME_BYTES = 128 * 1024


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: smoke-cleanup-worker.py WORKER")
    request = json.dumps({
        "modelPath": "/definitely/missing/model.gguf",
        "prompt": "protocol smoke",
        "requestId": "protocol-smoke",
    }).encode()
    frame = struct.pack(">I", len(request)) + request
    process = subprocess.run(
        [sys.argv[1]],
        check=False,
        input=frame,
        stderr=subprocess.PIPE,
        stdout=subprocess.PIPE,
        timeout=10,
    )
    if len(process.stdout) < 4:
        raise SystemExit("worker returned no framed response")
    size = struct.unpack(">I", process.stdout[:4])[0]
    if size == 0 or size > MAX_FRAME_BYTES:
        raise SystemExit(f"worker returned invalid frame size: {size}")
    body = process.stdout[4:]
    if len(body) != size:
        raise SystemExit("worker returned an incomplete frame")
    response = json.loads(body)
    if response.get("requestId") != "protocol-smoke":
        raise SystemExit("worker returned a mismatched request ID")
    if response.get("status") != "error" or not response.get("error"):
        raise SystemExit("missing model did not return a structured error")
    print("cleanup worker protocol smoke: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
