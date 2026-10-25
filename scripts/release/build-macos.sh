#!/usr/bin/env bash
# Compile the macOS app and cleanup worker for release, without bundling or
# signing. bundle-macos.sh then bundles, signs and notarizes.
# BUS-119: dependency build scripts (cargo build.rs, npm lifecycle scripts,
# llama.cpp's cmake) run here, so this phase must never see any APPLE_*
# value, secret or not. The workflow gives this step no secrets; the unset
# below also covers a local run with signing variables exported.
# Usage: scripts/release/build-macos.sh <rust-target>   (e.g. universal-apple-darwin)
set -euo pipefail

TARGET="${1:?usage: build-macos.sh <rust-target>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

while IFS= read -r var; do
  unset "$var"
done < <(compgen -e | grep '^APPLE_' || true)

# BUS-16 3c-2b: the cleanup worker sidecar. Its externalBin entry lives in a
# merge config, not tauri.conf.json, because tauri-build fails any cargo
# build that lacks the sidecar file and the dev/test builds never make one.
bash scripts/release/build-worker.sh "$TARGET"
npm run tauri -- build --no-bundle --target "$TARGET" \
  --config src-tauri/tauri.worker.conf.json -- --locked --features whisper

# A universal app must carry both arches before it is bundled and signed.
if [[ "$TARGET" == universal-apple-darwin ]]; then
  # cargo runs in src-tauri, so a relative CARGO_TARGET_DIR is under it.
  TARGET_DIR="${CARGO_TARGET_DIR:-target}"
  [[ "$TARGET_DIR" = /* ]] || TARGET_DIR="src-tauri/$TARGET_DIR"
  archs="$(lipo -archs "$TARGET_DIR/$TARGET/release/voxloom")"
  if [[ "$archs" != *arm64* || "$archs" != *x86_64* ]]; then
    echo "error: universal app binary has archs '$archs'" >&2
    exit 1
  fi
  echo "universal app binary archs: $archs"
fi
