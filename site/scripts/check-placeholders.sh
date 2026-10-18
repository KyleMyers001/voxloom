#!/usr/bin/env bash
# Pre-deploy check for PLACEHOLDER markers in the site's files.
# Exit 0: none found. Exit 1: markers remain (listed). Exit 2: grep error (e.g. unreadable file).
# Usage: site/scripts/check-placeholders.sh   (works from any directory)
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
rc=0
grep -rn --exclude-dir=scripts --exclude=README.md PLACEHOLDER . || rc=$?
case $rc in
  0) echo "error: PLACEHOLDER markers remain (above). Fill them in before deploying." >&2; exit 1 ;;
  1) echo "OK: no PLACEHOLDER markers found."; exit 0 ;;
  *) echo "error: grep failed (exit $rc); the check could not complete." >&2; exit 2 ;;
esac
