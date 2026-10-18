#!/usr/bin/env bash
# Create (or, on re-run, update) the draft GitHub Release for a tag.
# Refuses to touch a release that is already published.
# Usage: scripts/release/publish.sh <tag> <title> <notes-file> <asset-dir>
set -euo pipefail

TAG="${1:?tag}"
TITLE="${2:?title}"
NOTES="${3:?notes file}"
DIR="${4:?asset dir}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

shopt -s nullglob
assets=("$DIR"/*)
if ((${#assets[@]} == 0)); then
  echo "error: no release assets in $DIR" >&2
  exit 1
fi

if ! gh release view "$TAG" >/dev/null 2>&1; then
  gh release create "$TAG" "${assets[@]}" --draft --verify-tag \
    --title "$TITLE" --notes-file "$NOTES" --generate-notes
  exit 0
fi

if [[ "$(gh release view "$TAG" --json isDraft -q .isDraft)" != "true" ]]; then
  echo "error: release $TAG already published; refusing to modify it." >&2
  exit 1
fi

echo "Draft release $TAG exists; updating assets and notes."
new_names=()
for f in "${assets[@]}"; do new_names+=("$(basename "$f")"); done
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  if [[ ! " ${new_names[*]} " == *" $name "* ]]; then
    echo "Deleting stale asset: $name"
    gh release delete-asset "$TAG" "$name" --yes
  fi
done < <(gh release view "$TAG" --json assets -q '.assets[].name')

gh release upload "$TAG" "${assets[@]}" --clobber

# `gh release edit` cannot regenerate notes, so append GitHub's generated ones.
combined="$(mktemp)"
cat "$NOTES" > "$combined"
printf '\n' >> "$combined"
gh api "repos/$REPO/releases/generate-notes" -f tag_name="$TAG" -q .body >> "$combined"
gh release edit "$TAG" --title "$TITLE" --notes-file "$combined"
rm -f "$combined"
