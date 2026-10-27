#!/usr/bin/env bash
# Bundle the app compiled by build-macos.sh into .app and .dmg. With a
# complete set of Apple secrets, Tauri signs (app, worker, dmg), notarizes
# and staples the .app; otherwise it bundles ad-hoc (UNSIGNED).
# BUS-119: this and the package step are the only ones with Apple secrets,
# and neither compiles: `tauri bundle` builds nothing, so no dependency
# build script can read them.
# Usage: scripts/release/bundle-macos.sh <rust-target>
# Writes SIGNED (and APPLE_API_KEY_PATH) to $GITHUB_ENV when running in Actions.
set -euo pipefail

TARGET="${1:?usage: bundle-macos.sh <rust-target>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

SIGNED="$(bash scripts/release/signing-env.sh)"
to_env() { [[ -z "${GITHUB_ENV:-}" ]] || echo "$1=$2" >> "$GITHUB_ENV"; }
to_env SIGNED "$SIGNED"

if [[ "$SIGNED" == "true" ]]; then
  echo "Apple signing secrets found: bundling Developer ID signed + notarized."
  if [[ -n "${APPLE_API_PRIVATE_KEY:-}" ]]; then
    APPLE_API_KEY_PATH="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/AuthKey_${APPLE_API_KEY}.p8"
    # umask only applies to a new file, so never write into an old one.
    rm -f "$APPLE_API_KEY_PATH"
    # In Actions the package step still needs the key; the workflow's
    # "Remove App Store Connect key" step deletes it. Locally, delete it here.
    if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
      trap 'rm -f "$APPLE_API_KEY_PATH"' EXIT
    fi
    (umask 077 && printf '%s' "$APPLE_API_PRIVATE_KEY" > "$APPLE_API_KEY_PATH")
    export APPLE_API_KEY_PATH
    to_env APPLE_API_KEY_PATH "$APPLE_API_KEY_PATH"
  fi
  unset APPLE_API_PRIVATE_KEY
  # Tauri tests these with var_os, so a variable set to '' still counts:
  # an empty APPLE_ID + APPLE_PASSWORD next to APPLE_TEAM_ID selects Apple
  # ID notarization over the API key (HTTP 401). Pass only real values.
  while IFS= read -r var; do
    [[ -n "${!var}" ]] || unset "$var"
  done < <(compgen -e | grep '^APPLE_' || true)
else
  echo "No Apple signing secrets: bundling ad-hoc signed (UNSIGNED) release."
  # Empty values would make Tauri attempt (and fail) signing/notarization.
  while IFS= read -r var; do
    unset "$var"
  done < <(compgen -e | grep '^APPLE_' || true)
fi

npm run tauri -- bundle --target "$TARGET" --bundles app,dmg \
  --config src-tauri/tauri.worker.conf.json --features whisper
