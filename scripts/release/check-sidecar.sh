#!/usr/bin/env bash
# Check the cleanup worker sidecar inside a built Voxloom.app (BUS-16 3c-2b):
# present and executable, built for the target's arches, signed with the
# hardened runtime like the app, no debug-only test hooks, and its
# third-party notices bundled. Mac-only (lipo, codesign).
# Usage: scripts/release/check-sidecar.sh <path/to/Voxloom.app> <rust-target>
set -euo pipefail

APP="${1:?usage: check-sidecar.sh <Voxloom.app> <rust-target>}"
TARGET="${2:?usage: check-sidecar.sh <Voxloom.app> <rust-target>}"
SIDECAR="$APP/Contents/MacOS/voxloom-cleanup-worker"
NOTICES="$APP/Contents/Resources/licenses/cleanup-worker/THIRD-PARTY-NOTICES.txt"

fail() { echo "error: $*" >&2; exit 1; }

[[ -x "$SIDECAR" ]] || fail "no executable sidecar at $SIDECAR"
[[ -s "$NOTICES" ]] || fail "no worker notices at $NOTICES"
# Any debug-only test hook: SLOW_GENERATION, PANIC, FAKE_MODEL, …
if grep -q VOXLOOM_WORKER_TEST_ "$SIDECAR"; then
  fail "the sidecar contains a debug-only test hook (VOXLOOM_WORKER_TEST_*)"
fi

case "$TARGET" in
  universal-apple-darwin) want=(arm64 x86_64) ;;
  aarch64-apple-darwin) want=(arm64) ;;
  x86_64-apple-darwin) want=(x86_64) ;;
  *) fail "unknown target $TARGET" ;;
esac
archs="$(lipo -archs "$SIDECAR")"
for arch in "${want[@]}"; do
  [[ " $archs " == *" $arch "* ]] || fail "sidecar archs '$archs' lack $arch"
done

codesign --verify --strict --verbose=2 "$SIDECAR"
codesign --verify --deep --strict --verbose=2 "$APP"
details="$(codesign -dv --verbose=4 "$SIDECAR" 2>&1)"
app_details="$(codesign -dv --verbose=4 "$APP" 2>&1)"
grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime' <<<"$details" \
  || fail "sidecar is not signed with the hardened runtime"
# Same signer as the app: both ad-hoc, or the same TeamIdentifier.
team() { sed -n 's/^TeamIdentifier=//p' <<<"$1"; }
[[ "$(team "$details")" == "$(team "$app_details")" ]] \
  || fail "sidecar TeamIdentifier '$(team "$details")' != app '$(team "$app_details")'"

echo "sidecar OK: $(wc -c < "$SIDECAR" | tr -d ' ') bytes, archs: $archs"
grep -E '^(Identifier|CodeDirectory|TeamIdentifier|Signature)' <<<"$details"

# Optional at runtime on supported Macs, required in every distributed bundle.
PARAKEET="$APP/Contents/MacOS/voxloom-parakeet-worker"
PARAKEET_NOTICES="$APP/Contents/Resources/licenses/parakeet-worker/THIRD-PARTY-NOTICES.txt"
[[ -x "$PARAKEET" ]] || fail "no executable Parakeet helper at $PARAKEET"
[[ -s "$PARAKEET_NOTICES" ]] || fail "no Parakeet attribution notices at $PARAKEET_NOTICES"
parakeet_archs="$(lipo -archs "$PARAKEET")"
for arch in "${want[@]}"; do
  [[ " $parakeet_archs " == *" $arch "* ]] \
    || fail "Parakeet helper archs '$parakeet_archs' lack $arch"
done
if grep -q VOXLOOM_PARAKEET_TEST_ "$PARAKEET"; then
  fail "Parakeet helper contains test hooks"
fi
codesign --verify --strict --verbose=2 "$PARAKEET"
parakeet_details="$(codesign -dv --verbose=4 "$PARAKEET" 2>&1)"
grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime' <<<"$parakeet_details" \
  || fail "Parakeet helper is not signed with the hardened runtime"
[[ "$(team "$parakeet_details")" == "$(team "$app_details")" ]] \
  || fail "Parakeet helper signer differs from the app"
echo "Parakeet helper OK: archs: $parakeet_archs"
