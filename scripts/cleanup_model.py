"""Allowlisted descriptor verification for opt-in, offline cleanup diagnostics."""

from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import os
import stat


@dataclass(frozen=True)
class Artifact:
    model_id: str
    size: int
    sha256: str


# Kept in parity with the native importer by test_cleanup_template.py.
PIN = Artifact(
    "qwen3-0.6b-q4-k-m", 396_705_472,
    "ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a",
)


@contextmanager
def verified_model(path, artifact=PIN):
    """Hold one no-follow regular fd, verify it fully, rewind, and inherit it.

    The optional artifact is a test seam, not a CLI override of the allowlist.
    Descriptor identity survives path replacement; this does not freeze writes
    by another process with access to that same inode.
    """
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != artifact.size:
            raise ValueError("model must be a regular allowlisted-size file")
        if os.pread(fd, 4, 0) != b"GGUF":
            raise ValueError("model is not GGUF")
        digest = hashlib.sha256()
        remaining = artifact.size
        while remaining:
            chunk = os.read(fd, min(1024 * 1024, remaining))
            if not chunk:
                raise ValueError("model changed during verification")
            digest.update(chunk)
            remaining -= len(chunk)
        if os.read(fd, 1) or digest.hexdigest() != artifact.sha256:
            raise ValueError("model does not match the allowlisted digest")
        os.lseek(fd, 0, os.SEEK_SET)
        yield fd
    finally:
        os.close(fd)
