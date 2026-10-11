#!/usr/bin/env bash
# Pre-deploy check: exits 1 if any PLACEHOLDER marker remains in the site's pages.
# Usage: site/scripts/check-placeholders.sh   (works from any directory)
set -euo pipefail
cd "$(dirname "$0")/.."
if grep -rn --exclude-dir=scripts --exclude=README.md PLACEHOLDER .; then
  echo "error: PLACEHOLDER markers remain (above). Fill them in before deploying." >&2
  exit 1
fi
echo "OK: no PLACEHOLDER markers found."
