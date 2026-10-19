#!/usr/bin/env bash
# Assert (and optionally repair) that Voxloom.app embeds Entitlements.plist
# and is signed the way the environment expects (BUS-96):
#   APPLE_SIGNING_IDENTITY unset or "-": ad-hoc (today's default).
#   APPLE_SIGNING_IDENTITY set: the app must carry a Developer ID signature,
#     and --repair re-signs with that identity.
#   APPLE_TEAM_ID set: the signature's TeamIdentifier must match it.
# Mac-only: codesign is unavailable on Linux forge hosts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_APP="$ROOT/src-tauri/target/release/bundle/macos/Voxloom.app"
ENTITLEMENTS="$ROOT/src-tauri/Entitlements.plist"
BUNDLE_ID="com.voxloom.prototype"
IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
TEAM_ID="${APPLE_TEAM_ID:-}"
REPAIR=0
APP=""

usage() {
  cat <<USAGE
Usage: $(basename "$0") [--repair] [path/to/Voxloom.app]

Assert that the packaged .app embeds com.apple.security.device.audio-input.
With --repair, re-sign using src-tauri/Entitlements.plist and
--identifier $BUNDLE_ID, with \$APPLE_SIGNING_IDENTITY (ad-hoc "-" if unset).
An ad-hoc repair never overwrites a Developer ID signature.
Set \$APPLE_TEAM_ID to also check the signature's TeamIdentifier.

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

signature_info() {
  codesign -dv --verbose=4 "$APP" 2>&1 || true
}

is_developer_id_signed() {
  signature_info | grep -q '^Authority=Developer ID Application:'
}

sign_with_identity() {
  codesign --force --sign "$IDENTITY" \
    --identifier "$BUNDLE_ID" \
    --options runtime \
    --entitlements "$ENTITLEMENTS" \
    "$1"
}

echo "== codesign identity / identifier =="
signature_info | grep -E '^(Identifier|Authority|TeamIdentifier|Signature|Flags|CodeDirectory|Format)=' || true

echo
echo "== embedded entitlements =="
if has_audio_input; then
  dump_entitlements
  echo
  echo "OK: com.apple.security.device.audio-input is embedded."
else
  echo "(none / missing audio-input)"
  if [[ "$REPAIR" -eq 1 ]]; then
    if [[ "$IDENTITY" == "-" ]] && is_developer_id_signed; then
      echo "error: refusing to re-sign ad-hoc over a Developer ID signature." >&2
      echo "Set APPLE_SIGNING_IDENTITY to the Developer ID identity and re-run." >&2
      exit 1
    fi
    echo
    echo "Repairing with codesign --sign \"$IDENTITY\" + Entitlements.plist ..."
    MAIN_BIN="$APP/Contents/MacOS/voxloom"
    if [[ -f "$MAIN_BIN" ]]; then
      sign_with_identity "$MAIN_BIN"
    fi
    sign_with_identity "$APP"
    echo
    echo "== after repair =="
    signature_info | grep -E '^(Identifier|Authority|TeamIdentifier|Signature|Flags)=' || true
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

echo
if [[ "$IDENTITY" != "-" ]]; then
  if ! is_developer_id_signed; then
    echo "error: APPLE_SIGNING_IDENTITY is set; expected a Developer ID signature." >&2
    echo "Rebuild with APPLE_SIGNING_IDENTITY exported in the same shell." >&2
    exit 1
  fi
  echo "OK: signed with a Developer ID identity."
fi
if [[ -n "$TEAM_ID" ]]; then
  if ! signature_info | grep -qx "TeamIdentifier=$TEAM_ID"; then
    echo "error: expected TeamIdentifier=$TEAM_ID (from APPLE_TEAM_ID)." >&2
    exit 1
  fi
  echo "OK: TeamIdentifier is $TEAM_ID"
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
