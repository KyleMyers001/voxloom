"""Bounded POSIX child exchange with per-child wait4 RSS, never cumulative RSS."""

import os
import selectors
import signal
import struct
import subprocess
import sys
import time

MAX_FRAME_BYTES = 128 * 1024
STDERR_LIMIT = 8192


class ProcessStartError(OSError):
    """No child successfully launched; unlike post-launch harness failures."""


def exchange(argv, payload, *, timeout, stdout_limit, pass_fds=(), framed=False):
    """Drain output while writing input; kill/reap before returning or raising.

    A complete worker frame ends an attempt (including early startup errors).
    Continue draining already-written bytes after termination to detect excess
    output. Node bridge calls instead wait for EOF. No child-supplied diagnostic
    text is exposed by this helper. Supported platforms are macOS and Linux.
    """
    if sys.platform not in ('darwin', 'linux'):
        raise OSError('per-child RSS requires macOS or Linux wait4')
    started = time.monotonic()
    try:
        process = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, pass_fds=pass_fds, start_new_session=True,
        )
    except OSError as error:
        raise ProcessStartError('child did not launch') from error
    outputs = {'stdout': bytearray(), 'stderr': bytearray()}
    sizes = {'stdout': 0, 'stderr': 0}
    fault = None
    sent = 0
    reaped = False
    usage = None
    stopped_at = None

    def stop():
        nonlocal stopped_at
        if stopped_at is None:
            stopped_at = time.monotonic()
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def reap(block=False):
        nonlocal reaped, usage
        if not reaped:
            pid, status, resource = os.wait4(
                process.pid, 0 if block else os.WNOHANG)
            if pid:
                process.returncode = os.waitstatus_to_exitcode(status)
                usage = resource
                reaped = True

    try:
        with selectors.DefaultSelector() as selector:
            for stream, kind, event in (
                (process.stdin, 'stdin', selectors.EVENT_WRITE),
                (process.stdout, 'stdout', selectors.EVENT_READ),
                (process.stderr, 'stderr', selectors.EVENT_READ),
            ):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, event, kind)
            while selector.get_map() or not reaped:
                now = time.monotonic()
                if stopped_at is None and now - started >= timeout:
                    fault = 'timeout'
                    stop()
                if stopped_at is not None and now - stopped_at >= 1:
                    fault = fault or 'pipe-teardown'
                    break
                for key, _ in selector.select(0.01):
                    stream, kind = key.fileobj, key.data
                    if kind == 'stdin':
                        try:
                            sent += os.write(stream.fileno(), payload[sent:sent + 8192])
                        except BrokenPipeError:
                            selector.unregister(stream)
                            stream.close()
                            continue  # A valid early error may already be in stdout.
                        except BlockingIOError:
                            continue
                        if sent == len(payload):
                            selector.unregister(stream)
                            stream.close()
                        continue
                    try:
                        chunk = os.read(stream.fileno(), 8192)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        selector.unregister(stream)
                        stream.close()
                        continue
                    sizes[kind] += len(chunk)
                    limit = stdout_limit if kind == 'stdout' else STDERR_LIMIT
                    room = max(0, limit - len(outputs[kind]))
                    outputs[kind].extend(chunk[:room])
                    if sizes[kind] > limit:
                        fault = fault or f'{kind}-limit'
                        stop()
                    if framed and kind == 'stdout' and len(outputs[kind]) >= 4:
                        size = struct.unpack('>I', outputs[kind][:4])[0]
                        if size == 0 or size > MAX_FRAME_BYTES:
                            fault = fault or 'frame-size'
                            stop()
                        elif len(outputs[kind]) >= size + 4:
                            # Match native settlement: stop once the response is
                            # framed; an early error must not wait for stdin.
                            stop()
                reap()
                if reaped and not selector.get_map():
                    break
    except OSError:
        fault = fault or 'process-io'
    finally:
        # Also covers KeyboardInterrupt and unexpected parent I/O failures.
        # Kill the disposable process group to release inherited pipe handles.
        stop()
        reap(block=True)
        for stream in (process.stdin, process.stdout, process.stderr):
            if not stream.closed:
                stream.close()
    return {
        'stdout': bytes(outputs['stdout']),
        'stderrBytes': sizes['stderr'],
        'fault': fault,
        'inputComplete': sent == len(payload),
        'pid': process.pid,
        'exitCode': process.returncode,
        'seconds': time.monotonic() - started,
        # Darwin reports bytes; Linux reports KiB. wait4 is for THIS child only.
        'peakRssBytes': int(usage.ru_maxrss * (1 if sys.platform == 'darwin' else 1024)),
    }
