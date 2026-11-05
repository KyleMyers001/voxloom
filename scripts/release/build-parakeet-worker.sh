#!/usr/bin/env bash
# Build the optional macOS 14+ Core ML transcription helper. This executable
# has its own deployment target; it does not raise the parent app's macOS 13.1
# minimum. No signing credentials belong in this compilation phase.
set -euo pipefail

TARGET="${1:?usage: build-parakeet-worker.sh <rust-target>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKER="$ROOT/src-tauri/parakeet-worker"
OUT="$ROOT/src-tauri/binaries"
NAME="voxloom-parakeet-worker"

case "$TARGET" in
  universal-apple-darwin) ARCHES=(aarch64-apple-darwin x86_64-apple-darwin) ;;
  aarch64-apple-darwin|x86_64-apple-darwin) ARCHES=("$TARGET") ;;
  *) printf 'error: unsupported Parakeet build target: %s\n' "$TARGET" >&2; exit 1 ;;
esac

while IFS= read -r var; do
  unset "$var"
done < <(compgen -e | grep '^APPLE_' || true)

[[ -s "$WORKER/Package.resolved" ]] || {
  printf 'error: Parakeet Package.resolved is required\n' >&2
  exit 1
}
mkdir -p "$OUT"
for arch in "${ARCHES[@]}"; do
  case "$arch" in
    aarch64-apple-darwin) triple=arm64-apple-macosx14.0 ;;
    x86_64-apple-darwin) triple=x86_64-apple-macosx14.0 ;;
  esac
  args=(--package-path "$WORKER" --configuration release --triple "$triple"
    --disable-automatic-resolution --product "$NAME")
  swift build "${args[@]}"
  bin_dir="$(swift build "${args[@]}" --show-bin-path)"
  [[ -x "$bin_dir/$NAME" ]] || {
    printf 'error: no compiled Parakeet helper at %s\n' "$bin_dir/$NAME" >&2
    exit 1
  }
  cp "$bin_dir/$NAME" "$OUT/$NAME-$arch"
  # ASR-only SwiftPM traits must not silently add runtime resource bundles.
  # A dependency change that introduces them requires explicit bundle handling.
  if compgen -G "$bin_dir/*.bundle" >/dev/null; then
    printf 'error: unexpected Swift resource bundle; update packaging explicitly\n' >&2
    exit 1
  fi
done

if [[ "$TARGET" == universal-apple-darwin ]]; then
  lipo -create -output "$OUT/$NAME-$TARGET" \
    "$OUT/$NAME-aarch64-apple-darwin" "$OUT/$NAME-x86_64-apple-darwin"
fi

archs="$(lipo -archs "$OUT/$NAME-$TARGET")"
case "$TARGET" in
  universal-apple-darwin) want=(arm64 x86_64) ;;
  aarch64-apple-darwin) want=(arm64) ;;
  x86_64-apple-darwin) want=(x86_64) ;;
esac
for arch in "${want[@]}"; do
  [[ " $archs " == *" $arch "* ]] || {
    printf 'error: Parakeet helper lacks architecture %s\n' "$arch" >&2
    exit 1
  }
done
printf 'Parakeet helper built: %s (%s)\n' "$OUT/$NAME-$TARGET" "$archs"
