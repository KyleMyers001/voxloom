# Cleanup worker resource

`scripts/build-cleanup-worker.sh` requires a clean local llama.cpp checkout at
commit `c1d0e7a004015f23bc0233470b747b596f29b264`. It requests an arm64 macOS 13.3
worker with embedded Metal resources and `GGML_NATIVE=OFF`, runs weight-free
checks, and places the untracked executable in this directory. No source or
weights are downloaded. Source/build paths are configurable via
`VOXLOOM_LLAMA_CPP_SOURCE` and `VOXLOOM_CLEANUP_BUILD_DIR`.

Existing worker resources are not replaced unless explicitly authorized with
`VOXLOOM_CLEANUP_REPLACE_WORKER=1`. The script prints `file`, `lipo`, and `otool`
inspection output. Build settings alone do not prove compatibility on older
Apple Silicon hardware or macOS versions.

The default bundle is workerless. Use `src-tauri/tauri.cleanup.conf.json` to
bundle only the executable (not this README) with the optional macOS 13.3+ floor.
The ordinary workerless configuration declares macOS 13.1.
Use `--target aarch64-apple-darwin` for the app build. Debug development runs can
also discover this resource directly; see the root README for build commands.

Readiness requires a regular file with executable permission bits. This does
not prove that the worker can load the model or generate correct output.
The build's weight-free template smoke uses the upstream Jinja file. The separate
opt-in command below verifies the allowlisted GGUF on a held descriptor, then
checks its actual metadata through the same user-message/non-thinking renderer
as generation (metadata/vocabulary only, not inference):

```sh
python3 scripts/check-cleanup-template.py \
  /absolute/path/to/build/voxloom-template-check /absolute/path/to/model.gguf
```

Direct `voxloom-template-check --model PATH` is a low-level diagnostic and does
not verify the allowlist; use the Python wrapper for evidence. Neither command
fetches weights. The wrapper's checker-process deadline is 30 seconds, after
file verification. The worker's source now rejects invalid UTF-8, literal U+FFFD,
and unsafe ASCII controls, returns fixed bounded diagnostics, and suppresses
backend stdout during execution and stderr throughout the worker process.

Weight-free checks (installed Node/Vite dependencies required; no upstream
source or model needed):

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/native -v
```

**Current build evidence:** the full revised worker/template checker builds
against the clean pin; safety, token lifetime, upstream Jinja, and four framed
error checks pass on macOS 26.6.2 (arm64). The scratch binary is arm64, declares
13.3, and passes local `codesign --verify --strict`; it has not been installed or
bundled. This is not packaged signing or older-system compatibility evidence.

**Approved floor change:** pinned upstream has unguarded Metal calls introduced
in macOS 12 and Accelerate NEWLAPACK calls introduced in 13.3. Raising only the
optional worker/app configuration to 13.3 removes the diagnosed availability
warnings in a fresh build. The pin and backends are unchanged; no upstream patch
was made. The actual-GGUF check and real inference/corpus measurements are now
recorded in [model evaluation](../../../docs/review/BUS-16-model-evaluation.md).
Human quality review, packaged smoke/signatures and live compatibility remain
separate gates. The optional build is for local dogfooding, not certified public
distribution.
