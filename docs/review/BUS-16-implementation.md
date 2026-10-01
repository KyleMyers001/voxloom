# BUS-16 local cleanup implementation

## Approved optional-floor checkpoint — 2026-09-30

Kyle explicitly approved raising **only optional cleanup to macOS 13.3** while
preserving the ordinary workerless **10.15** declaration. Both the worker CMake
floor (before compiler detection) and `tauri.cleanup.conf.json` are now 13.3.
The default config, upstream pin, architecture and backends are unchanged.

Regression-first: the revised config tests initially had **2 failures / 5 passes**,
then all **7 passed**. Fresh verification also passes **489 frontend tests across
68 files**, lint/typecheck, and **11 Python/C++ helper/tool tests**.

A new, separate scratch build against the clean pin compiled all four C++ targets
on macOS 26.6.2/arm64. **None of the three diagnosed availability warnings recur**;
the configure notice about missing optional ccache remains. Safety, token lifetime,
upstream Jinja, and all four real framed-error smoke cases pass. `file`/`lipo`
confirm arm64, `otool` reports **minos 13.3**, and strict signature verification
passes. The old 11.0 scratch build and evidence remain intact; no resource or app
was installed/replaced. This is not a packaged-app or older-OS test.

The narrow floor decision is resolved. Actual GGUF metadata/generation, corpus
quality and latency/RAM, supported-OS/hardware validation, packaged builds and
permitted Tauri/microphone/AX/clipboard checks remain. Browser/Rust suites were
not rerun for this config-only change; their earlier results below are historical.
No weights, upstream modification, push/merge, or PR/Jira mutation. Keep PR #24 draft.

## Pinned worker build checkpoint — 2026-09-30 (historical)

Kyle explicitly approved fetching the pinned upstream source for scratch
compilation/testing, without weights or artifact replacement. A fresh checkout
of `b10621` matches `c1d0e7a004015f23bc0233470b747b596f29b264` and remains clean.
The **full worker, template checker, safety checker, and token-state checker
compile successfully**. All four weight-free checks pass on macOS 26.6.2/arm64,
including the real worker's four structured-error protocol cases. An additional
inherited synthetic `GGUFtest` descriptor reaches real backend/model loading and
returns a fixed runtime error with quiet stderr and one clean frame. No actual
allowlisted GGUF, generation, or actual-metadata template result is established.

The scratch worker is **arm64**, declares **macOS 11.0**, links system frameworks,
and passes `codesign --verify --strict`. Nothing was installed into checkout
resources or an app bundle; this is not packaged/signing/distribution proof.

**New compatibility blocker:** the pin's Metal event synchronization invokes
`waitUntilSignaledValue:timeoutMS:` without a macOS 12 availability guard. Its
BLAS backend calls macOS 13.3 `cblas_sgemm` NEWLAPACK/ILP64 APIs without a guard;
the binary contains the corresponding weak Accelerate import. Build success and
the 11.0 load command therefore do not establish support for the approved floor.
Do not silently raise it, disable backends, or modify the clean source pin.
A narrow compatibility decision is required before completion; recommending a
13.3 optional floor avoids these diagnosed API-floor conflicts, but still would
not certify old hardware/OS behavior. The ordinary workerless 10.15 declaration
is unchanged.

The SDK emitted these three availability warnings (two Accelerate calls, one
Metal call). Configure also reported missing optional ccache and an unused
`FETCHCONTENT_FULLY_DISCONNECTED` guard; no extra dependency download occurred.
Previous frontend/helper/browser/Rust evidence below is unchanged-code evidence,
not newly rerun for this build-only continuation. Hosted CI remains unrun.
Corpus tooling, real-model quality/performance, packaged and permitted live
checks still remain. No source code changed in this continuation; no weights,
worker-resource/app replacements, push/merge, or PR/Jira mutation. Keep PR #24 draft.

## Worker safety/tooling checkpoint — 2026-09-30 (historical)

Current local checks: **489 frontend tests / 68 files**, lint, typecheck, isolated
production build, **6 browser tests**, both offline locked Cargo checks, and five
fresh default/Whisper pairs (**177/176 each**) pass. **11 new Python/C++ helper/tool
tests** pass, compiling the dependency-free safety checker with C++17,
`-Wall -Wextra -Werror -DNDEBUG`. The four existing Rust warnings remain.

**Important boundary:** the full revised C++ worker and template checker have
**not** been compiled against the pinned llama.cpp source. Their integration,
real framed smoke, and actual-GGUF template/generation remain unverified. The
new Python tests use synthetic files/fake executables; source-wiring assertions
are not a substitute for compilation or model tests. Hosted CI has not run.

Source changes and helper evidence:

- Strict final-byte UTF-8 validation rejects overlong/truncated sequences,
  surrogates and out-of-range code points. Token fragments are joined before
  validation, allowing split emoji. Literal U+FFFD and unsafe ASCII controls also
  fall back conservatively. The frontend independently rejects these and lone
  UTF-16 surrogates while preserving valid Unicode and formatting whitespace.
- Typed, fixed diagnostics bound error codes/messages and avoid reflecting JSON,
  tokenizer, or template exceptions containing prompts. Missing/nonregular model
  inputs use `model-missing`; output byte/truncation/encoding failures use
  `invalid-output`. IDs are bounded before reflection. Token sizing checks also
  avoid large allocations/negative-count overflow before context rejection.
- Disposable-worker stderr is redirected to `/dev/null`; backend stdout is
  suppressed during generation and restored for framing, including exception
  unwinding. Tests exercise both C and C++ buffered writes. These trade useful
  library debug logs for transcript privacy and protocol integrity.
- Generation and template checks share `prompt_renderer.hpp`. Weight-free Jinja
  smoke remains separate. The new `--model` checker loads GGUF vocabulary/metadata
  and verifies the non-thinking suffix through the same user-message renderer.
- `scripts/check-cleanup-template.py CHECKER GGUF` verifies the allowlisted size,
  magic, and full hash using a no-follow regular descriptor, rewinds it, and
  inherits it into the checker. Pin parity, path replacement, tampering, symlinks,
  nonregular files, and result propagation are tested. No downloads or writes to
  models. Direct low-level `--model` use is not allowlist verification.
- Weight-free protocol smoke now checks four intentional error cases, bounded
  diagnostics, quiet stderr, failure exit, and no reflected synthetic prompt.
  Its harness is tested with fake executables; the real worker remains unbuilt.
  macOS CI now includes `python3 -m unittest discover -s tests/native -v`.

**Next:** obtain an approved clean upstream source path (or specific permission
to fetch the pin) to compile/check the full worker. Corpus fixture/evaluator,
real-model quality and latency/RAM, packaged/signature/compatibility, actual
Tauri channel/lifecycle, and permitted microphone/AX/clipboard gates remain.
No source/weight download, worker-resource/app replacement, live interaction,
push, merge, or PR/Jira mutation occurred. Keep PR #24 draft.

## Native boundary checkpoint — 2026-09-30 (historical)

Current local evidence: **479 frontend tests across 68 files**, lint, typecheck,
isolated production build, and **6 Chromium browser tests** pass. Both offline
locked Cargo checks pass. Five fresh default/Whisper suite pairs pass under normal
parallelism: **177/176 tests per run**. The four existing native warnings remain;
there is no hosted-CI, real-model, or packaged/live result from this continuation.

Implemented:

- Serialize the exact worker request before spawning, stopping serialization at
  the **128 KiB JSON-body cap** rather than allocating an unbounded payload. Tests
  cover escaping, UTF-8, the exact limit, no spawn on overflow, and slot recovery.
- Concurrent pipe reads preserve early structured errors even if the child exits
  without reading stdin. Empty IDs are permitted only on bounded `error` responses;
  successful or nonempty mismatched IDs remain rejected. The parent validates
  response shape, 64-byte codes, 1024-byte diagnostics, and 32000-byte output.
- Native attempt evidence means **a successfully spawned child received the same
  descriptor whose contents were verified**. It is not proof of model loading or
  successful generation. Success and post-launch failures carry that model ID and
  digest; preflight/missing-runtime/spawn failures do not invent attribution.
  Synthetic tests cover tampering, failed exec, crash, cancellation, and recovery.
- A scoped Tauri channel reports launch for live UI state; final IPC results carry
  independent evidence if the notification is lost. Cancellation drains the native
  result after reaping before timeout fallback/history proceeds. Invalid, duplicate,
  late, and disposed notifications cannot manufacture a cleaning phase. Channels
  are not allocated for failed session handshakes. Actual Tauri channel/lifecycle
  behavior still needs live validation, beyond Rust callbacks and JS mocks.
- Acquire failures retain their structured reason without modifying the model
  snapshot. History attribution no longer derives from `fallback` status. Cleaning
  follows actual launch, then switches to **Delivering**; keyboard/FIFO behavior
  remains covered. Cancellation also wins while fallback teardown is pending.
- Partials are created with mode 0600, before any bytes are copied. Copy sources
  use no-follow regular descriptors; shape/magic/hash validation uses one descriptor.
  Import syncs the parent directory after rename. A sync failure is reported while
  retaining the valid renamed file, and retry syncs an already-valid installation.
  This tests ordering/error handling, not recovery from a physical power failure.

**Remaining:** C++ UTF-8/error/log handling, actual-GGUF template verification,
real-model corpus tooling and evaluation, worker/app build and signature/compatibility
checks, actual renderer lifecycle/channel behavior and permitted microphone/AX/
clipboard scenarios, plus final PR dispositions. No weights/source downloads,
real app/model replacements, or interactive native checks occurred. No push/merge
or PR/Jira mutation. Keep PR #24 draft. Earlier checkpoints below are historical.

## Text/evidence checkpoint — 2026-09-30 (historical)

The approved dependency reinstall succeeded without changing `package-lock.json`.
Current checks now pass: **447 frontend tests**, lint, typecheck, isolated Vite
build, and **6 Chromium browser tests** (including honest browser-only cleanup
readiness). Both offline locked Cargo checks and five fresh default/Whisper suite
pairs passed again: **168/167 tests each run**, normal parallelism. Four existing
native warnings remain. The macOS CI job is configured and its YAML/configuration
checks pass locally; **hosted execution is not established**. npm audit reports
three existing locked dependency vulnerabilities (one moderate, two high); no
unrequested dependency upgrades were made.

Implemented since the ownership checkpoint:

- Empty/whitespace STT exits before cleanup, target validation, or OS writes;
  cancellation takes precedence. Reservations/leases settle; no history row or
  fake success. Actual capture/path integration tests exercise these boundaries.
- Whole technical lexemes and their multiplicities must match; substring/prefix
  substitutions and added protected values are rejected. Content retention and
  candidate coverage are both **100% after explicit normalization**, in order.
  Negation and pronouns have additional multiset checks. Normalization permits
  punctuation, paragraphing, selected fillers/articles/contractions, bounded
  dictionary spelling/joining, and comma-marked single-word corrections. These
  are intentionally restrictive heuristics, not semantic-equivalence proofs.
- Deferred insertion failure after cancellation retains `writeStarted: true`,
  the original failure, and history evidence, with no subsequent clipboard write.
- Unknown native error codes map to `runtime-error`. Malformed/unknown cleanup
  metadata degrades to `unavailable`, preserving valid v2 raw/final text and
  delivery status across save/load and retention. Legacy migration bookkeeping
  stays in data but is hidden from ordinary History presentation.

**Still incomplete:** native serialized-frame preflight and structured startup
errors; actual-attempt provenance, acquire-error preservation, and accurate
cleaning phase; remaining worker UTF-8/error/log/template/import hardening; real
corpus tooling and evaluation; actual packaged/lifecycle/native interactions and
compatibility evidence. No model/source download, worker/app replacement, or
microphone/AX/clipboard/renderer-crash interaction was performed. Chromium was
installed for browser tests; its artifacts were isolated outside the checkout.
Keep PR #24 draft. The older checkpoint below is historical where superseded.

## Ownership checkpoint — 2026-09-30 (historical)

Revision-1 completion work remains **partial**; keep PR #24 draft. The earlier
review-pass results below are historical, not proof that the current checkout
has a worker, real-model quality evidence, or a fully passing validation gate.

Current ownership changes:

- Every cleanup command checks the invoking native main webview/window. Request
  commands additionally require a native-issued session. Navigation start,
  renderer termination, window destruction, and explicit hook disposal retire
  that owner; stale acquires cannot restore its pending leases.
- Pending descriptors are reclaimed outside registry locks. Running tasks retain
  their descriptors until kill/reap completes. Cancellation and release are
  scoped to the owner/request; active/retired jobs still count toward admission.
- Admission opens a no-follow regular descriptor without hashing the model.
  Before inference, the same held descriptor is fully verified on a blocking
  task outside state locks. No inode/mtime cache substitutes for integrity.
- One supervisor transition lock reserves before spawn and preserves cancellation
  during spawn. Cancellation waiters cannot advance FIFO before native settlement.
  Hook teardown aborts queued/active jobs, disposes the session, and supports
  StrictMode remounts. Settings/readiness fixes from the prior checkpoint remain.

Current local checks: both Cargo checks passed; five sequential default/Whisper
suite pairs passed under normal parallel execution (**168/167 tests per run**).
The late-output recovery test now uses a 3-second success deadline and a 60-second
intentional stall, preserving recovery through the same supervisor. Frontend
suite: **376 passed, 4 failed**, all four due to the missing installed
`@stylistic/eslint-plugin`; lint is blocked by that dependency. TypeScript and
Vite build checks passed with isolated output. Native checks retain four known
pre-existing warnings.

These tests use synthetic workers/model fixtures. Actual Tauri lifecycle events,
real GGUF inference, bundle/import, microphone/AX/clipboard behavior, signatures,
and compatibility remain unverified. Silence/fidelity/delivery-evidence fixes,
truthful error/provenance/history boundaries, remaining worker hardening/corpus,
and macOS Rust CI are still pending. No new worker/app build or weight download
was performed in this checkpoint.

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

The normal bundle is workerless. Optional local dogfood cleanup targets
Apple Silicon/macOS 13.3+; it is not a public-distribution or M1 compatibility
certification. See the root README for source/build directory overrides and
artifact-replacement safeguards. With a clean local checkout at the exact pin,
run:

```sh
./scripts/build-cleanup-worker.sh
CARGO_TARGET_DIR=/absolute/path/to/new/tauri-target \
  npm run tauri -- build --debug --bundles app \
  --target aarch64-apple-darwin --features whisper \
  --config src-tauri/tauri.cleanup.conf.json
```

The script verifies the immutable commit, builds static CPU/Accelerate/Metal
libraries with embedded Metal resources, checks stable generated-token batch
storage, runs the non-thinking template check, places the ignored worker
executable in the Tauri resource tree, and runs the committed weight-free
framed-protocol smoke.
The build cache is intentionally retained outside the worktree for review.

## Independent review pass 1 resolutions

Review pass 1 requested changes against `4238c95`; this follow-up resolves all
accepted findings:

- **A — capture acquisition ownership:** a pending/active capture admission
  rejects another start without advancing its UI session or invoking native
  capture. Deferred acquisition, duplicate stopped-event, FIFO overlap, and
  third-start-before-mic regressions are deterministic hook tests.
- **B/C — supervisor timeout and lock ordering:** the child is registered
  before a writer thread touches stdin; one spawn-based deadline covers stdin
  and stdout; cancellation can kill the child without holding the active-state
  mutex; kill/reap completes before the slot clears. Fake-process tests cover
  pipe backpressure, concurrent/repeated cancellation, timeout, and recovery.
- **D — complete FIFO jobs:** provenance hashing, record construction, and the
  history callback now run inside the reserved job before it settles. An
  overlapping full-capture test proves first history precedes second STT and
  that a third start never reaches microphone acquisition.
- **E — model integrity and leases:** admission acquires a request-scoped
  native lease, queued and active leases block import, and every lease hashes
  an opened regular file. That same descriptor is inherited by the worker as
  `/dev/fd/3`, closing pathname reopen races. Tests cover same-size tampering
  and multiple queued/inflight leases against import.
- **F — dynamic prompt data:** transcript and dictionary values are serialized
  as one escaped JSON payload; angle brackets, ampersands, quotes, and newlines
  cannot break its line boundary. This is delimiter hardening, not a claim of
  semantic prompt-injection prevention; output validation remains mechanical.
- **G — direct runtime coverage:** committed fake-worker tests cover framed
  success, blocked stdin, active cancellation, timeout kill/reap, malformed
  and mismatched output, crash recovery, and late-output isolation. Resource
  layout has a direct test and the build script runs a committed protocol
  smoke. Signing/notarization remains a manual check.
- **H — truthful fallback reasons:** native command failures are structured by
  code, including context overflow, timeout, cancellation, missing model, and
  runtime failure. Renderer history no longer infers these from message text.

## Independent review pass 2 resolutions

Review pass 2 requested changes against `2db96b9`; this follow-up resolves all
accepted findings:

- **Cancellation lifecycle across remounts:** coordinator request IDs now use
  a UUID-backed per-instance prefix. Cancelling an admitted request before a
  native run releases its lease without creating a native cancellation
  tombstone, and native release explicitly settles any existing tombstone.
  Hook and supervisor regressions cover disabled/STT cancellation followed by
  reuse from a new coordinator.
- **History after asynchronous provenance:** delivery outcomes now carry
  explicit `writeStarted` and `writeCommitted` evidence. Cancellation while
  provenance hashing is pending suppresses history only when no delivery write
  began; attempted or committed writes retain their actual outcome.
- **Supervisor recovery:** malformed-output and crash fake workers fail once,
  then succeed through the same supervisor instance. This proves recovery
  rather than merely repeating a failure.
- **Generated-token lifetime:** pinned llama.cpp's `llama_batch_get_one`
  borrows its token pointer. The worker now owns stable token storage outside
  the decode loop, and a compiled check verifies that consecutive batches
  retain that address. This is a lifetime/control-flow check, not an inference
  or quality result.
- **Weight-free smoke startup:** the reproduced 10-second timeout was embedded
  Metal initialization (about 10.4 seconds) occurring before the missing model
  was rejected. The worker now validates the inherited model descriptor's GGUF
  header before backend initialization, so the committed missing-model smoke
  returns a structured framed error within its original 10-second bound.

## Verification and remaining live checks

Automated coverage includes admission capacity/FIFO/cancel isolation, prompt
and output bounds, cleanup timeout/fallback, native command adapters, settings
import, settings/history migrations, raw/final integration, cancellation at
delivery write boundaries, model validation/private atomic copy/leases,
bounded framing, full fake-process supervisor behavior, worker compilation,
template rendering, resource layout, and a repeatable framed protocol smoke.

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
- the C++ frame implementation is covered by the committed weight-free process
  smoke; the worker and template check are compiled against the exact pin.
- `cleanup/mod.rs`, the NSOpenPanel FFI adapter, CMake target declarations,
  and Tauri command registration are thin boundary/bootstrap wiring. They are
  compile-checked; live picker behavior remains a manual check.

Still unverified because no weight or live system interaction was authorized:

- actual Qwen inference and cleanup quality
- peak memory, 30-second success rate, and cold latency
- live native model picker/import of the 396705472-byte artifact
- microphone capture and macOS Accessibility insertion
- packaged signing/notarization of the generated worker and Metal resources

The reviewed Qwen base-model Apache-2.0 license identity and exact artifact
repository attribution are recorded in `docs/third-party/qwen3-0.6b.md`. This
is not a legal certification, and no model is redistributed here.

### Pass 1 fix verification

- `npm run lint` — passed
- `npm run typecheck` — passed
- `npm run test:unit` — 346 passed
- `npm run build` — passed
- `cargo check` — passed with four pre-existing warnings
- `cargo test --lib` — 152 passed
- `./scripts/build-cleanup-worker.sh` — pinned build, Qwen3 non-thinking
  template check, and committed protocol smoke passed
- `npm run tauri -- build --debug` — app bundle built with the worker at
  `Contents/Resources/cleanup/voxloom-cleanup-worker`
- `codesign --verify --deep --strict` — the local ad-hoc debug bundle passed;
  distribution signing and notarization remain unverified

### Pass 2 fix verification

- `npm run lint` and `npm run typecheck` — passed
- `npm run test:unit` — 351 passed
- `npm run build` — passed
- `cargo check` — passed with the same four pre-existing warnings
- `cargo test --lib` — 153 passed
- `./scripts/build-cleanup-worker.sh` — pinned worker build, stable-token
  lifetime check, Qwen3 non-thinking template check, and 10-second-bounded
  missing-model protocol smoke passed in 2.26 seconds with a warm build cache
- packaged worker protocol smoke — passed in 0.02 seconds on the debug bundle
- `npm run tauri -- build --debug` — passed with the worker resource present
- `codesign --verify --deep --strict` — local ad-hoc debug bundle passed;
  distribution signing and notarization remain unverified

Cold one-shot worker/model load is intentionally unoptimized and unbenchmarked
in this first slice. No quality benchmark claim is made.
