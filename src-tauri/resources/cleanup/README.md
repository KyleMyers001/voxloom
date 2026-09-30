# Cleanup worker resource

`scripts/build-cleanup-worker.sh` requires a clean local llama.cpp checkout at
commit `c1d0e7a004015f23bc0233470b747b596f29b264`. It requests an arm64 macOS 11.0
worker with embedded Metal resources and `GGML_NATIVE=OFF`, runs weight-free
checks, and places the untracked executable in this directory. No source or
weights are downloaded. Source/build paths are configurable via
`VOXLOOM_LLAMA_CPP_SOURCE` and `VOXLOOM_CLEANUP_BUILD_DIR`.

Existing worker resources are not replaced unless explicitly authorized with
`VOXLOOM_CLEANUP_REPLACE_WORKER=1`. The script prints `file`, `lipo`, and `otool`
inspection output. Build settings alone do not prove compatibility on older
Apple Silicon hardware or macOS versions.

The default bundle is workerless. Use `src-tauri/tauri.cleanup.conf.json` to
bundle only the executable (not this README) with the optional macOS 11+ floor.
Use `--target aarch64-apple-darwin` for the app build. Debug development runs can
also discover this resource directly; see the root README for build commands.

Readiness requires a regular file with executable permission bits. This does
not prove that the worker can load the model or generate correct output.
The current template check uses the upstream Jinja file, not the actual GGUF's
metadata. Actual-template tests, real inference, packaged smoke/signature
verification, and live compatibility validation remain separate gates. The
optional build is for local dogfooding, not certified public distribution.
