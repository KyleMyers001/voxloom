#!/usr/bin/env bash
# Collect release assets: <name>.dmg, zipped .app and SHA256SUMS in dist-release/.
# Verifies entitlements (no repair) and, for signed builds, notarization.
# Usage: scripts/release/package-macos.sh <rust-target> <version> <signed:true|false>
set -euo pipefail

TARGET="${1:?target}"
VERSION="${2:?version}"
SIGNED="${3:-false}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUNDLE="$ROOT/src-tauri/target/$TARGET/release/bundle"
APP="$BUNDLE/macos/Voxloom.app"
OUT="$ROOT/dist-release"

case "$TARGET" in
  universal-apple-darwin) ARCH=universal ;;
  aarch64-apple-darwin) ARCH=arm64 ;;
  x86_64-apple-darwin) ARCH=x86_64 ;;
  *) ARCH="$TARGET" ;;
esac
SUFFIX=""
[[ "$SIGNED" == "true" ]] || SUFFIX="-unsigned"
NAME="Voxloom_${VERSION}_macos_${ARCH}${SUFFIX}"

# Fails the build if the mic entitlement is missing; never repairs in CI.
bash "$ROOT/scripts/macos-assert-entitlements.sh" "$APP"

DMG="$(find "$BUNDLE/dmg" -maxdepth 1 -name '*.dmg' | head -n 1)"
if [[ -z "$DMG" ]]; then
  echo "error: no .dmg found under $BUNDLE/dmg" >&2
  exit 1
fi

if [[ "$SIGNED" == "true" ]]; then
  # Tauri notarizes and staples the .app; notarize + staple the dmg too.
  if [[ -n "${APPLE_API_KEY:-}" ]]; then
    xcrun notarytool submit "$DMG" --wait --key "$APPLE_API_KEY_PATH" \
      --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER"
  else
    xcrun notarytool submit "$DMG" --wait --apple-id "$APPLE_ID" \
      --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID"
  fi
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$APP"
  spctl -a -vv "$APP"
  spctl -a -vv -t open --context context:primary-signature "$DMG"
fi

rm -rf "$OUT"
mkdir -p "$OUT"
cp "$DMG" "$OUT/$NAME.dmg"
ditto -c -k --keepParent "$APP" "$OUT/$NAME.app.zip"
(cd "$OUT" && shasum -a 256 ./*.dmg ./*.zip | sed 's# \./# #' > SHA256SUMS)
cat "$OUT/SHA256SUMS"
