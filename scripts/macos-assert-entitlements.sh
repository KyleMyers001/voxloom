#!/usr/bin/env bash
# Assert (and optionally repair) that Voxloom.app embeds Entitlements.plist.
# Mac-only: codesign is unavailable on Linux forge hosts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_APP="$ROOT/src-tauri/target/release/bundle/macos/Voxloom.app"
ENTITLEMENTS="$ROOT/src-tauri/Entitlements.plist"
BUNDLE_ID="com.voxloom.prototype"
REPAIR=0
APP=""

usage() {
  cat <<USAGE
Usage: $(basename "$0") [--repair] [path/to/Voxloom.app]

Assert that the packaged .app embeds com.apple.security.device.audio-input.
With --repair, ad-hoc re-sign using src-tauri/Entitlements.plist and
--identifier $BUNDLE_ID.

Default app path:
  $DEFAULT_APP
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repair) REPAIR=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*)
      echo "error: unknown flag: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$APP" ]]; then
        echo "error: unexpected argument: $1" >&2
        exit 2
      fi
      APP="$1"
      shift
      ;;
  esac
done

APP="${APP:-$DEFAULT_APP}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macos-assert-entitlements: skipping (not macOS)." >&2
  exit 0
fi

if [[ ! -d "$APP" ]]; then
  echo "error: app bundle not found: $APP" >&2
  echo "Build first: npm run tauri -- build --bundles app" >&2
  exit 1
fi

if [[ ! -f "$ENTITLEMENTS" ]]; then
  echo "error: missing $ENTITLEMENTS" >&2
  exit 1
fi

dump_entitlements() {
  codesign -d --entitlements :- "$APP" 2>/dev/null || true
}

has_audio_input() {
  dump_entitlements | grep -q 'com.apple.security.device.audio-input'
}

echo "== codesign identity / identifier =="
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E '^(Identifier|Authority|TeamIdentifier|Signature|Flags|CodeDirectory|Format)=' || true

echo
echo "== embedded entitlements =="
if has_audio_input; then
  dump_entitlements
  echo
  echo "OK: com.apple.security.device.audio-input is embedded."
else
  echo "(none / missing audio-input)"
  if [[ "$REPAIR" -eq 1 ]]; then
    echo
    echo "Repairing with ad-hoc codesign + Entitlements.plist ..."
    MAIN_BIN="$APP/Contents/MacOS/voxloom"
    if [[ -f "$MAIN_BIN" ]]; then
      codesign --force --sign - \
        --identifier "$BUNDLE_ID" \
        --options runtime \
        --entitlements "$ENTITLEMENTS" \
        "$MAIN_BIN"
    fi
    codesign --force --sign - \
      --identifier "$BUNDLE_ID" \
      --options runtime \
      --entitlements "$ENTITLEMENTS" \
      "$APP"
    echo
    echo "== after repair =="
    codesign -dv --verbose=4 "$APP" 2>&1 | grep -E '^(Identifier|Authority|TeamIdentifier|Signature|Flags)=' || true
    dump_entitlements
    if has_audio_input; then
      echo "OK: entitlements embedded after repair."
    else
      echo "error: repair failed — audio-input still missing." >&2
      exit 1
    fi
  else
    echo
    echo "FAIL: expected com.apple.security.device.audio-input in embedded entitlements." >&2
    echo "Re-run with --repair, or rebuild after setting signingIdentity to \"-\"." >&2
    exit 1
  fi
fi

ID_LINE="$(codesign -dv "$APP" 2>&1 | grep '^Identifier=' || true)"
echo
echo "Identifier line: ${ID_LINE:-"(missing)"}"
if echo "$ID_LINE" | grep -q "Identifier=$BUNDLE_ID"; then
  echo "OK: Identifier is $BUNDLE_ID"
else
  echo "WARN: Identifier is not $BUNDLE_ID (ad-hoc may still use a derived id)."
  echo "      Info.plist CFBundleIdentifier should still be $BUNDLE_ID for TCC."
  echo "      Re-run with --repair to force -i $BUNDLE_ID."
fi
