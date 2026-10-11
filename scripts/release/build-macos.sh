#!/usr/bin/env bash
# Build the macOS app + dmg for release. Signs and notarizes only when Apple
# secrets are present; otherwise produces an ad-hoc (unsigned) build.
# Usage: scripts/release/build-macos.sh <rust-target>   (e.g. universal-apple-darwin)
# Writes SIGNED=true|false to $GITHUB_ENV when running in Actions.
set -euo pipefail

TARGET="${1:?usage: build-macos.sh <rust-target>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

SIGNED=false
if [[ -n "${APPLE_CERTIFICATE:-}" && -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  SIGNED=true
  echo "Apple signing secrets found: building Developer ID signed + notarized."
  if [[ -n "${APPLE_API_PRIVATE_KEY:-}" ]]; then
    APPLE_API_KEY_PATH="$RUNNER_TEMP/AuthKey_${APPLE_API_KEY}.p8"
    printf '%s' "$APPLE_API_PRIVATE_KEY" > "$APPLE_API_KEY_PATH"
    export APPLE_API_KEY_PATH
    [[ -z "${GITHUB_ENV:-}" ]] || echo "APPLE_API_KEY_PATH=$APPLE_API_KEY_PATH" >> "$GITHUB_ENV"
  fi
else
  echo "No Apple signing secrets: building ad-hoc signed (UNSIGNED) release."
  # Empty values would make Tauri attempt (and fail) signing/notarization.
  unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY \
    APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER \
    APPLE_API_PRIVATE_KEY
fi
unset APPLE_API_PRIVATE_KEY

if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "SIGNED=$SIGNED" >> "$GITHUB_ENV"
fi

npm run tauri -- build --target "$TARGET" --bundles app,dmg -- --locked --features whisper
