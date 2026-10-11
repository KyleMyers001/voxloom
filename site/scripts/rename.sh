#!/usr/bin/env bash
# Usage: site/scripts/rename.sh "NewName"   (works from any directory)
# Replaces the product name (default "Voxloom") literally in site/*.html and site/*.css:
# page text, <title>, and meta/social tags. Any characters are safe (& / \ etc.).
# Leaves GitHub URLs (KyleMyers001/voxloom, lowercase) untouched. Logo/footer are uppercased via CSS.
# Not covered: assets/og.png (name is baked into the image) and favicon.svg (no text).
# Reverse with: OLD="NewName" site/scripts/rename.sh Voxloom
# Note: the round trip is only lossless if NewName does not already appear in the pages.
set -euo pipefail
NEW="${1:?usage: $0 NewName}"; OLD="${OLD:-Voxloom}"
[ -n "$OLD" ] || { echo "OLD must not be empty" >&2; exit 2; }
cd "$(dirname "$0")/.."
shopt -s nullglob
files=(./*.html ./*.css)
[ ${#files[@]} -gt 0 ] || { echo "no .html/.css files found in $(pwd)" >&2; exit 1; }
export OLD NEW
for f in "${files[@]}"; do
  tmp="$(mktemp "${f}.rename.XXXXXX")"
  # \Q..\E quotes the search; the replacement is a plain variable, so no metacharacters apply.
  if ! perl -pe 's/\Q$ENV{OLD}\E/$ENV{NEW}/g' -- "$f" > "$tmp"; then
    rm -f -- "$tmp"; echo "rename failed on $f" >&2; exit 1
  fi
  chmod --reference="$f" "$tmp" 2>/dev/null || true
  mv -f -- "$tmp" "$f"
done
# Skip the leftover check when NEW contains OLD (e.g. "Voxloom Pro"): matches are expected then.
if [[ "$NEW" != *"$OLD"* ]] && grep -nF -- "$OLD" "${files[@]}"; then
  echo "error: \"$OLD\" still present after rename (see matches above)" >&2; exit 1
fi
echo "Renamed ${OLD} -> ${NEW} in ${#files[@]} files. Remaining matches: (none)"
