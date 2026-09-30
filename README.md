# Voxloom — macOS-first local dictation (work in progress)

The Tauri desktop shell captures real microphone audio, can transcribe it
locally using an explicitly downloaded Whisper model (`--features whisper`),
and attempts to insert text into the invocation-time macOS target. When
insertion is unsafe or unavailable it can Copy instead, if clipboard fallback
is enabled; results report Inserted, Copied or Failed. The configured global
shortcut supports hold/release and double-tap latch. Native recording shows
one bottom floating waveform driven by rate-limited microphone levels (no PCM
sent to the webview); the main app no longer duplicates it. macOS permission
and Accessibility behavior require on-device verification; Windows is not
verified.

The browser / Vite-only prototype uses synthetic capture, transcription and
focused-window shortcuts; state clears on reload. The Tauri shell persists
**Settings**, **History** and the **Word dictionary** in app data
(`settings.json`, `history.json`, `dictionary.json`). Native audio retry and
saved audio retention are not implemented. Onboarding practice recognizes
shortcut gestures but does not transcribe speech. Optional local cleanup is
experimental and not yet verified with real model generation; see the dogfood
setup below. Start-at-login is not implemented. Development scenario controls
are excluded from production builds. See
`docs/review/BUS-14-insert-delivery.md` for native smoke checks and limitations.

## Browser

```sh
npm install
npm run dev
```

Open `http://localhost:1420`.

## macOS desktop

With the Rust and macOS build toolchains installed:

```sh
npm run tauri -- dev
```

Dev runs under the Tauri helper; System Settings → Privacy → Microphone may
list your terminal (e.g. WezTerm), not Voxloom. For real TCC client identity,
build a packaged `.app` (see below).

Windows is not verified by this repository.

### Packaged `.app` (TCC identity)

```sh
# Mic / UI identity smoke
npm run tauri -- build --bundles app

# Full local STT (requires cmake)
brew install cmake   # once
npm run tauri -- build --bundles app -- --features whisper
```

App path:

```text
src-tauri/target/release/bundle/macos/Voxloom.app
```

Open it, request mic access, then confirm **Voxloom** appears under
System Settings → Privacy & Security → Microphone. Details and deny/revoke
gaps: `docs/review/BUS-10-packaged-tcc.md`.

After build, confirm codesign embedded the mic entitlement (ad-hoc or
Developer ID):

```sh
npm run macos:assert-entitlements
# codesign -d --entitlements :- src-tauri/target/release/bundle/macos/Voxloom.app
```

See `docs/review/BUS-10-entitlements-codesign.md` if the dump is empty.

## Local STT (whisper.cpp)

Speech-to-text is local-first (see `docs/decisions/local-stt-whisper.md`).
The TypeScript layer talks to `SttEngine` / `SttModelStore`; a mock adapter
backs UI tests. The Tauri shell exposes `stt_*` commands for model
download (explicit user action only) and transcription.

Real whisper.cpp linkage is **opt-in** on macOS:

```sh
brew install cmake   # once
npm run tauri -- dev -- --features whisper
```

Details: `docs/review/BUS-10-whisper.md`.

## Optional local cleanup (BUS-16, draft)

Cleanup is opt-in and offline, using an explicitly imported, allowlisted
Qwen3 0.6B Q4_K_M GGUF. Import does **not** enable cleanup automatically.
In Settings, the installed model, executable worker, selected model, and
cleanup checkbox are separate prerequisites. Use **Refresh cleanup status**
to recheck them; returning focus to Settings also refreshes. Cleanup can always
be turned off, even when the model or worker is unavailable.

Blank STT bypasses cleanup and delivery. Cleanup candidates must preserve whole
technical-token multisets (including repeated numbers, flags, paths, and hosts)
and normalized content in order. Only bounded dictionary spelling/joining,
fillers/articles, and narrowly marked spoken corrections are discounted.
Ambiguous rewrites fall back to raw once. These conservative lexical checks are
not semantic-equivalence or real-model quality proof. A cancelled failed insert
retains attempted-write evidence without starting clipboard fallback. Unreadable
cleanup metadata leaves valid History text intact with unavailable provenance.

New history attributes a model only when native code confirms a successfully
spawned worker received that model's verified descriptor. Preflight fallback is
not a model attempt; an attempt is not proof of successful generation. The live
cleanup phase follows native launch, then switches to delivery. Worker JSON
request bodies are capped at 128 KiB including escaping/UTF-8 overhead, before
spawning (plus a four-byte frame header). That limit is distinct from the 16000-byte raw-input limit, 4096-token context,
64-token minimum output reserve, 1024-token generation cap, and 32000-byte output
limit. Imported partial files are private from creation; installation syncs the
containing directory after rename.

**Importing a GGUF does not install the worker.** A missing/non-executable
worker requires a worker-equipped build; reimporting the model cannot fix it.
The ordinary bundle contains no worker and retains its macOS 10.15 declaration.
The optional cleanup target is **Apple Silicon/macOS 11+**, for local developer
use only—not a signed/notarized public release or a verified M1 compatibility
claim. Intel/universal cleanup is outside the current scope.

Provide a clean local llama.cpp checkout at the exact pin in
`docs/third-party/llama.cpp.md`. The build script does not fetch source or
weights. Then, from the repository root:

```sh
VOXLOOM_LLAMA_CPP_SOURCE=/absolute/path/to/clean/llama.cpp \
VOXLOOM_CLEANUP_BUILD_DIR=/absolute/path/to/new/build-directory \
  ./scripts/build-cleanup-worker.sh

# Choose a fresh target directory to preserve existing app bundles.
CARGO_TARGET_DIR=/absolute/path/to/new/tauri-target \
  npm run tauri -- build --debug --bundles app \
  --target aarch64-apple-darwin --features whisper \
  --config src-tauri/tauri.cleanup.conf.json
```

The build runs weight-free protocol, UTF-8/safety, token-state, and upstream
Jinja checks. After separately providing the allowlisted GGUF, check its actual
metadata with the same renderer as generation:

```sh
python3 scripts/check-cleanup-template.py \
  /absolute/path/to/new/build-directory/voxloom-template-check \
  /absolute/path/to/qwen3-0.6b-q4-k-m.gguf
```

This holds a fully verified descriptor and uses metadata/vocabulary only. It is
not a generation/fidelity test. Source and model downloads are never automatic.
The revised C++ worker/template integration remains unbuilt against the pin;
standalone helper tests are not a substitute for that gate. See
`src-tauri/resources/cleanup/README.md` for checks and current limitations.

The worker script refuses to replace an existing resource unless explicitly
allowed with `VOXLOOM_CLEANUP_REPLACE_WORKER=1`. Do not opt in without approval
to replace that artifact. A debug development run may also find the provisioned
worker directly in `src-tauri/resources/cleanup`; this does not put it in an
ordinary bundle. Import the exact local GGUF described in
`docs/third-party/qwen3-0.6b.md`, then enable cleanup explicitly.

The optional configuration bundles only the executable. Its build requests
arm64, macOS 11.0, and `GGML_NATIVE=OFF`; inspect the resulting `file`, `lipo`,
and `otool` output and verify the app's ad-hoc signature before native testing.
The template/protocol smoke is weight-free and **not** real-Qwen evidence.
Actual GGUF template/generation, fidelity, latency/RAM, packaged import,
Whisper/microphone/AX/clipboard behavior, and compatibility remain live-validation
gates. Native owner reclamation now has deterministic registry/adapter tests
and synthetic-worker kill/reap coverage, but actual renderer reload/crash checks
and other PR #24 safety fixes remain outstanding. Keep the PR draft.
Downloads, a persistent worker, and distribution certification
are deferred. See `docs/review/BUS-16-implementation.md` for the branch's prior
implementation evidence and known limitations.

## Verification

Pull requests targeting `main` run GitHub Actions CI on Node 24 and Ubuntu:
ESLint, Vitest unit tests, the TypeScript/Vite build, and Playwright Chromium
browser tests. The workflow also defines a separate macOS job for locked default
and Whisper Cargo checks plus five sequential suite pairs with normal test
parallelism. That job needs no model weights or interactive permissions and
does not certify the optional worker bundle. Its first hosted run is still
pending on this draft branch. To run the frontend checks locally after `npm ci`:

```sh
PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers npx playwright install chromium
npm run lint
npm run test:unit
npm run build             # includes tsc -b (typecheck)
npm run test:e2e
```

`npm run typecheck` remains available separately. ESLint enforces the
[Google TypeScript style guide](https://google.github.io/styleguide/tsguide.html)
subset of single-quoted ordinary strings and semicolons in JS/TS sources;
existing recommended correctness rules still apply. JSX attribute quotes
remain double-quoted. This is not a full style-guide migration.
CI does not build the macOS Tauri/Rust application or verify native microphone,
Accessibility, or permission behavior; those still need on-device checks.
