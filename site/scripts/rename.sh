#!/usr/bin/env bash
# Usage: site/scripts/rename.sh "NewName"   (works from any directory)
# Replaces the product name "Voxloom" in page text, <title>, and meta tags.
# Leaves GitHub URLs (KyleMyers001/voxloom, lowercase) untouched. Logo/footer are uppercased via CSS.
# Not covered: assets/og.png (name is baked into the image) and favicon.svg (no text).
set -euo pipefail
NEW="${1:?usage: $0 NewName}"; OLD="${OLD:-Voxloom}"
cd "$(dirname "$0")/.."
sed -i.bak "s/${OLD}/${NEW}/g" ./*.html ./*.css && rm -f ./*.bak
echo "Renamed ${OLD} -> ${NEW}. Remaining matches:"; grep -n "${OLD}" ./*.html ./*.css || echo "(none)"
