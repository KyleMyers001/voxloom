#!/usr/bin/env bash
set -euo pipefail

expected_commit="c1d0e7a004015f23bc0233470b747b596f29b264"
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
default_source="$repo_root/../voxloom-planning-inputs/upstream/llama.cpp-b10621"
default_build="$repo_root/../voxloom-build-cache/voxloom-cleanup-worker"
source_root="${VOXLOOM_LLAMA_CPP_SOURCE:-$default_source}"
build_root="${VOXLOOM_CLEANUP_BUILD_DIR:-$default_build}"
worker_dir="$repo_root/src-tauri/resources/cleanup"

actual_commit="$(git -C "$source_root" rev-parse HEAD)"
if [[ "$actual_commit" != "$expected_commit" ]]; then
  echo "llama.cpp pin mismatch: expected $expected_commit," \
    "got $actual_commit" >&2
  exit 1
fi

cmake \
  -S "$repo_root/native/cleanup-worker" \
  -B "$build_root" \
  -DCMAKE_BUILD_TYPE=Release \
  -DLLAMA_CPP_SOURCE="$source_root"
cmake --build "$build_root" --target \
  voxloom-cleanup-worker voxloom-template-check -j 8
"$build_root/voxloom-template-check" \
  "$source_root/models/templates/Qwen-Qwen3-0.6B.jinja"

mkdir -p "$worker_dir"
cp "$build_root/voxloom-cleanup-worker" \
  "$worker_dir/voxloom-cleanup-worker"
chmod 0755 "$worker_dir/voxloom-cleanup-worker"
python3 "$repo_root/scripts/smoke-cleanup-worker.py" \
  "$worker_dir/voxloom-cleanup-worker"
