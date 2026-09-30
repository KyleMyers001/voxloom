#!/usr/bin/env python3
"""Opt-in GGUF template check. Never downloads weights or edits model files."""

import argparse
from pathlib import Path
import subprocess

from cleanup_model import PIN, verified_model


def check(checker, model, artifact=PIN):
    with verified_model(model, artifact) as fd:
        result = subprocess.run(
            [str(Path(checker).resolve()), "--model", f"/dev/fd/{fd}"],
            pass_fds=(fd,), check=False, timeout=30,
        )
    return result.returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checker", type=Path, help="built voxloom-template-check")
    parser.add_argument("model", type=Path, help="existing allowlisted GGUF")
    args = parser.parse_args()
    try:
        return check(args.checker, args.model)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        # No library diagnostic, pathname, or model content is reflected.
        parser.exit(1, "Template check could not run: verify the checker and "
                    "allowlisted regular GGUF; the deadline is 30 seconds.\n")


if __name__ == "__main__":
    raise SystemExit(main())
