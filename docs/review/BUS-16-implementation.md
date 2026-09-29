# BUS-16 local cleanup implementation

## Candidate scope

This candidate adds one opt-in, offline cleanup pass between Whisper and the
single delivery decision. Cleanup is disabled and unselected by default. A
user must explicitly import the one allowlisted local GGUF through the native
picker; the renderer never supplies an executable or model path.

Two complete dictation jobs may be admitted. The first runs STT → cleanup or
fallback → delivery → history while a second recording may begin.
Jobs execute FIFO. A third start is rejected before microphone capture.
Request cancellation kills the matching worker and prevents later delivery or
history side effects where a write has not already begun.

## Runtime and artifact pins

- llama.cpp release: `b10621`
- llama.cpp commit: `c1d0e7a004015f23bc0233470b747b596f29b264`
- worker transport: private, length-prefixed JSON over stdin/stdout;
  diagnostics only on stderr; no HTTP listener
- model ID: `qwen3-0.6b-q4-k-m`
- model revision:
  `50968a4468ef4233ed78cd7c3de230dd1d61a56b`
- expected size: `396705472` bytes
- expected SHA-256:
  `ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a`

The staged LFS pointer was verified before these constants were registered.
No weight was downloaded. The pinned `common_chat_templates_apply` path and
`enable_thinking = false` were compiled and exercised against the bundled
Qwen3 template. See `docs/third-party/llama.cpp.md` for attribution.

## Bounds and fallback

- context: 4096 tokens after the actual model template is rendered
- output reserve: at least 64 and at most 1024 tokens
- raw input: at most 16000 UTF-8 bytes
- output: at most 32000 UTF-8 bytes and `2 × raw characters + 256`
- dictionary: 64 words, 2048 UTF-8 bytes total, 128 bytes per word
- transport frame: 128 KiB
- timeout: 30 seconds, including cold worker/model load

Prompt overflow, timeout, missing model, runtime failure, truncated output, or
invalid output selects the protected raw transcript once. Cancellation does
not select raw fallback. Generated reasoning wrappers and protected token
changes are rejected, but these mechanical checks are not a semantic quality
proof.

## Persistence and user surface

Settings v2 replaces the simulated Alder selection with disabled cleanup and
a nullable native model ID. History v2 stores final text as primary, raw text,
cleanup status/reason, model and prompt identity, and a canonical dictionary
digest. V1 history migrates raw equal to final with explicit legacy-skipped
provenance. Existing transcript retention removes raw and final together.

Settings reports model and worker availability separately, imports through an
NSOpenPanel, and never downloads or builds at inference time. History exposes
raw text only when it differs from final text. Existing AX insertion policy,
target validation, and clipboard fallback semantics remain unchanged.

## Build provisioning

The normal app builds without the optional worker and reports it unavailable.
For a developer build, stage the exact pinned llama.cpp tree next to the repo,
then run:

```sh
./scripts/build-cleanup-worker.sh
```

The script verifies the immutable commit, builds static CPU/Accelerate/Metal
libraries with embedded Metal resources, runs the non-thinking template
check, and places the ignored worker executable in the Tauri resource tree.
The build cache is intentionally retained outside the worktree for review.

## Verification and remaining live checks

Automated coverage includes admission capacity/FIFO/cancel isolation, prompt
and output bounds, cleanup timeout/fallback, native command adapters, settings
import, settings/history migrations, raw/final integration, cancellation at
delivery write boundaries, model validation/private atomic copy/leases,
bounded framing, supervisor refusal without a worker, worker compilation,
template rendering, and framed protocol smoke.

### Implementation-surface audit

- `cleanup/prompt`, `provenance`, `runCleanup`, `tauriAdapter`, and
  `validation` have direct tests under `tests/unit/cleanup`.
- `dictation/coordinator` has direct FIFO, capacity, and scoped-cancel tests.
- `CleanupSettings`, `Settings`, `History`, `Home`, shortcut gestures,
  delivery, the dogfood path, and capture hook are exercised by their direct
  unit/component suites; App integration covers the assembled renderer path.
- settings/history formats and record creation have direct migration and
  retention tests.
- native protocol, model store, and supervisor have colocated Rust tests.
- the C++ frame implementation is covered by a real process protocol smoke;
  the worker and template check are compiled against the exact pin.
- `cleanup/mod.rs`, the NSOpenPanel FFI adapter, CMake target declarations,
  and Tauri command registration are thin boundary/bootstrap wiring. They are
  compile-checked; live picker behavior remains a manual check.

Still unverified because no weight or live system interaction was authorized:

- actual Qwen inference and cleanup quality
- peak memory, 30-second success rate, and cold latency
- live native model picker/import of the 396705472-byte artifact
- microphone capture and macOS Accessibility insertion
- packaged signing/notarization of the generated worker and Metal resources
- Qwen artifact license/notice text (the staged inputs contained only its LFS
  identity, not an upstream license file; no model is redistributed here)

Cold one-shot worker/model load is intentionally unoptimized and unbenchmarked
in this first slice. No quality benchmark claim is made.
