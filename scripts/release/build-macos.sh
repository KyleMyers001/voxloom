#!/usr/bin/env bash
# Build the macOS app + dmg for release. Signs and notarizes only when a
# complete set of Apple secrets is present; otherwise builds ad-hoc (UNSIGNED).
# Usage: scripts/release/build-macos.sh <rust-target>   (e.g. universal-apple-darwin)
# Writes SIGNED (and APPLE_API_KEY_PATH) to $GITHUB_ENV when running in Actions.
set -euo pipefail

TARGET="${1:?usage: build-macos.sh <rust-target>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

SIGNED="$(bash scripts/release/signing-env.sh)"
to_env() { [[ -z "${GITHUB_ENV:-}" ]] || echo "$1=$2" >> "$GITHUB_ENV"; }
to_env SIGNED "$SIGNED"

if [[ "$SIGNED" == "true" ]]; then
  echo "Apple signing secrets found: building Developer ID signed + notarized."
  if [[ -n "${APPLE_API_PRIVATE_KEY:-}" ]]; then
    APPLE_API_KEY_PATH="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/AuthKey_${APPLE_API_KEY}.p8"
    (umask 077 && printf '%s' "$APPLE_API_PRIVATE_KEY" > "$APPLE_API_KEY_PATH")
    export APPLE_API_KEY_PATH
    to_env APPLE_API_KEY_PATH "$APPLE_API_KEY_PATH"
  fi
else
  echo "No Apple signing secrets: building ad-hoc signed (UNSIGNED) release."
  # Empty values would make Tauri attempt (and fail) signing/notarization.
  unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY \
    APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER
fi
unset APPLE_API_PRIVATE_KEY

npm run tauri -- build --target "$TARGET" --bundles app,dmg -- --locked --features whisper
