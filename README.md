# Voxloom — macOS-first local dictation (work in progress)

**Download:** [latest release](https://github.com/KyleMyers001/voxloom/releases/latest) (macOS; see [Releases](#releases)).

The Tauri desktop shell captures real microphone audio, can transcribe it
locally using an explicitly downloaded Whisper model (`--features whisper`),
and attempts to insert text into the transcription-completion-time macOS target. When
insertion is unsafe or unavailable it can Copy instead, if clipboard fallback
is enabled; results report Inserted, Copied, Failed, or Unverified (Terminal
events posted without input-buffer verification). The configured global
shortcut supports hold/release and double-tap latch. Native recording shows
one bottom floating waveform driven by rate-limited microphone levels (no PCM
sent to the webview); the main app no longer duplicates it. macOS permission
and Accessibility behavior require on-device verification; Windows is not
verified.

The browser / Vite-only prototype uses synthetic capture, transcription and
focused-window shortcuts; state clears on reload. The Tauri shell persists
**Settings**, **History** and the **Word dictionary** in app data
(`settings.json`, `history.json`, `dictionary.json`). Native audio retry and
saved audio retention are not implemented. Transcripts in `history.json` are
stored as **plain text**; see [PRIVACY.md](PRIVACY.md) for where they live,
how to delete them, and why the app enables Tauri's `macOSPrivateApi`. Onboarding practice recognizes
shortcut gestures but does not transcribe speech. Optional local cleanup is
experimental: real-model corpus runs show limited useful cleanup, while packaged
integration and human quality review remain pending; see the dogfood setup below.
Start-at-login is not implemented. Development scenario controls are excluded
from production builds.

### Dictation target selection

Focus the desired field **when transcription completes**. You can start in A,
release/Stop in B, then move to C while processing: C becomes the intended
field after the final text is ready. Release/Stop stops audio immediately,
without acquiring a target or waiting for AX. Automatic 120-second/capacity
stops use the same completion-time policy.

After that snapshot, the exact field must remain focused and insertable.
Further focus changes refuse insertion, with Copy (if enabled) or Failed/manual
recovery. Password/secure fields never receive insertion. Voxloom never
restores/steals focus or submits a message. Clicking Home Stop may leave focus
in Voxloom; switch to your desired field before transcription finishes.

The first native AX observation after final STT and optional local cleanup fixes the
target; event/IPC scheduling means this is not an atomic timestamp. If a cold or
idle-dropped Chromium/Electron AX tree is unavailable, Voxloom re-enables it on
every attempt and waits briefly (about 2.4 s at most) for the focused field in
the same, still-frontmost app; switching apps during that wait falls back (see
`docs/decisions/web-ax-reenable.md`). Cancelled/superseded work does not acquire a new
target or dispatch new delivery writes; any already-dispatched native insertion
cannot be retracted and retains native exact-target checks.

### Apple Terminal

The exact system Apple Terminal app has a separate guarded Unicode-event route
for validated text areas. It rejects control characters and line separators,
never sends Enter or uses clipboard transport, and never automatically copies
or retries after any events are posted. Complete/partial dispatch stays
**Unverified** in the result and History; inspect the prompt before using Copy.
Printable text can still trigger actions in terminal modes or TUIs: no Enter
is not a universal no-execution guarantee. Other terminal apps are not enabled
by this route. See `docs/decisions/apple-terminal-delivery.md` for guards,
evidence and remaining live checks.

## Browser

```sh
npm install
npm run dev
```

Open `http://localhost:1420`.

## macOS desktop

**Minimum macOS: 13.1 (Ventura).** The UI runs in the system WKWebView, so it
needs the WebKit that ships with Safari 16.2: `color-mix()` (Safari 16.2),
`:has()` (15.4), `Array.prototype.at()` (15.4) and `inert` (15.5). Declared in
`src-tauri/tauri.conf.json` → `bundle.macOS.minimumSystemVersion`.

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
npm run tauri -- build --bundles app -- --locked --features whisper
```

App path:

```text
src-tauri/target/release/bundle/macos/Voxloom.app
```

Open it, request mic access, then confirm **Voxloom** appears under
System Settings → Privacy & Security → Microphone.

After build, confirm codesign embedded the mic entitlement (ad-hoc or
Developer ID):

```sh
npm run macos:assert-entitlements
# codesign -d --entitlements :- src-tauri/target/release/bundle/macos/Voxloom.app
```

If the dump is empty, the app kept only the linker's ad-hoc signature, which
does not embed `src-tauri/Entitlements.plist`. Tauri runs `codesign` only when
a signing identity resolves; `bundle.macOS.signingIdentity` is `"-"` (ad-hoc)
for that reason. `npm run macos:assert-entitlements -- --repair` re-signs it.

To sign with a Developer ID instead, so permissions survive rebuilds, export
`APPLE_SIGNING_IDENTITY` (and `APPLE_TEAM_ID`) before building. See
[docs/macos-signing.md](docs/macos-signing.md).

## Releases

macOS builds are published as **draft** GitHub Releases by
`.github/workflows/release.yml` whenever a `v*` tag is pushed. Each release
has a universal `.dmg`, a zipped `.app` and `SHA256SUMS`.

Cutting a release:

```sh
npm run release:bump -- 0.2.0   # syncs package.json, tauri.conf.json, Cargo.toml (+ locks), commits, tags v0.2.0
git push && git push origin v0.2.0
```

Then review the draft release on GitHub, edit the notes (template:
`.github/release-notes.md`; changes are auto-generated from merged PRs), and
publish it. The workflow fails if the tag and manifest versions differ
(`npm run release:check-version -- v0.2.0`).

**Signing:** builds are ad-hoc signed and labeled **UNSIGNED** until these
secrets exist in the protected `release` Environment, after which tag pushes
are Developer ID signed, notarized and stapled automatically:
`APPLE_CERTIFICATE` (base64 `.p12`), `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID` (required for every signed build),
plus either `APPLE_API_KEY` + `APPLE_API_ISSUER` + `APPLE_API_PRIVATE_KEY`
(`.p8` contents, preferred) or `APPLE_ID` + `APPLE_PASSWORD` (app-specific).
Manual workflow runs never receive these secrets and always build ad-hoc.
Setup steps:
[docs/macos-signing.md](docs/macos-signing.md).

**Test build without releasing:** run the *Release* workflow manually
(Actions → Release → Run workflow). It uploads the build as a workflow
artifact and does not create a release.

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
The ordinary bundle contains no worker and declares macOS 13.1.
The optional cleanup target is **Apple Silicon/macOS 13.3+**, for local developer
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
The C++ worker/template checker builds against the clean pin and passes
weight-free checks on macOS 26.6.2 (arm64). The approved optional 13.3 floor aligns
with upstream's macOS 12 Metal and 13.3 Accelerate APIs; a fresh build no longer
emits the diagnosed availability warnings. No upstream patch or backend change
was needed. Actual GGUF template/generation has now been exercised on the M5
host, not a supported older OS/hardware target; this is not compatibility proof. See
`src-tauri/resources/cleanup/README.md` for details.

The worker script refuses to replace an existing resource unless explicitly
allowed with `VOXLOOM_CLEANUP_REPLACE_WORKER=1`. Do not opt in without approval
to replace that artifact. A debug development run may also find the provisioned
worker directly in `src-tauri/resources/cleanup`; this does not put it in an
ordinary bundle. Import the exact local GGUF described in
`docs/third-party/qwen3-0.6b.md`, then enable cleanup explicitly.

The optional configuration bundles only the executable. Its build requests
arm64, macOS 13.3, and `GGML_NATIVE=OFF`; inspect the resulting `file`, `lipo`,
and `otool` output and verify the app's ad-hoc signature before native testing.
The template/protocol smoke is weight-free and **not** real-Qwen evidence.
Actual GGUF template/generation and fixed-corpus latency/RSS are measured below.
Human quality review, packaged import, Whisper/microphone/AX/clipboard behavior
and older-system compatibility remain live-validation gates. Native owner reclamation now has deterministic registry/adapter tests
and synthetic-worker kill/reap coverage, but actual renderer reload/crash checks
and other PR #24 safety fixes remain outstanding. Keep the PR draft.
Downloads, a persistent worker, and distribution certification
are deferred. See `docs/review/BUS-16-implementation.md` for the branch's prior
implementation evidence and known limitations.

An offline [cleanup evaluation kit](docs/review/BUS-16-evaluator.md) now covers
23 synthetic cases across all three styles and dictionary modes, using the
production TypeScript prompt and output guards. Its Python runner records
per-attempt output, fallback, timing and memory evidence from an explicitly
supplied worker/GGUF. Weight-free tests exercise fake workers. The first actual
model run echoed JSON for every supported case; `cleanup-v2` now explicitly asks
for plain text. Regressions also reject observed emoji loss, added quotation
wrappers and name lowercasing without relaxing existing guards.

The final [real-model evaluation](docs/review/BUS-16-model-evaluation.md) recorded
17 useful changes, 72 unchanged outputs and 49 raw fallbacks across 138 variants,
with zero timeouts. This is limited usefulness, not complete style quality or a
semantic safety guarantee. Human review and packaged/live checks remain pending.

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
