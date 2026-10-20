#!/usr/bin/env bash
# Build the cleanup worker sidecar (BUS-16 3c-2b) into src-tauri/binaries/
# under the names Tauri's externalBin expects (tauri.worker.conf.json):
# voxloom-cleanup-worker-<triple>. For universal-apple-darwin, cargo runs
# once per arch, and each run's tauri-build wants its own arch's file, while
# the bundler wants the lipo'd universal one, so all three are written.
# Every binary is checked for the debug-only test hook (QA 3c-2a Low-2).
# Usage: scripts/release/build-worker.sh <rust-target>
set -euo pipefail

TARGET="${1:?usage: build-worker.sh <rust-target>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKER="$ROOT/src-tauri/worker"
OUT="$ROOT/src-tauri/binaries"
NAME="voxloom-cleanup-worker"
TARGET_DIR="${CARGO_TARGET_DIR:-$WORKER/target}"
# cargo resolves a relative CARGO_TARGET_DIR against the directory it runs
# in, which is $WORKER below, so the copy must look there too.
[[ "$TARGET_DIR" = /* ]] || TARGET_DIR="$WORKER/$TARGET_DIR"
HOOK="VOXLOOM_WORKER_TEST_SLOW_GENERATION"

case "$TARGET" in
  universal-apple-darwin) ARCHES=(aarch64-apple-darwin x86_64-apple-darwin) ;;
  *) ARCHES=("$TARGET") ;;
esac

mkdir -p "$OUT"
for arch in "${ARCHES[@]}"; do
  (cd "$WORKER" && cargo build --release --locked --target "$arch")
  cp "$TARGET_DIR/$arch/release/$NAME" "$OUT/$NAME-$arch"
done

if [[ "$TARGET" == universal-apple-darwin ]]; then
  lipo -create -output "$OUT/$NAME-$TARGET" \
    "$OUT/$NAME-aarch64-apple-darwin" "$OUT/$NAME-x86_64-apple-darwin"
  archs="$(lipo -archs "$OUT/$NAME-$TARGET")"
  if [[ "$archs" != *arm64* || "$archs" != *x86_64* ]]; then
    echo "error: universal worker has archs '$archs'" >&2
    exit 1
  fi
fi

for bin in "$OUT/$NAME-"*; do
  if grep -q "$HOOK" "$bin"; then
    echo "error: $bin contains the debug-only test hook ($HOOK)" >&2
    exit 1
  fi
  echo "$(basename "$bin"): $(wc -c < "$bin" | tr -d ' ') bytes"
done
