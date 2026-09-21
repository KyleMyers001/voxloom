# BUS-10 — Whisper wiring (local STT → Copy)

Branch: `bus-10-whisper-wiring`.

ADR: `docs/decisions/local-stt-whisper.md` (whisper.cpp first; **no silent
model download**; no silent upload; Copy before insert).

Scaffold baseline: `docs/review/BUS-10-scaffold.md` (contracts + mock + Copy
sink). This slice wires a real local path behind those contracts.

## What landed

| Layer | Role |
|-------|------|
| `SttEngine.modelId` | Explicit selected model (Emma review). Constructing an engine never downloads. |
| `src/services/stt/whisperAdapter.ts` | Tauri IPC client for model store + transcribe |
| `src/services/stt/mockStt.ts` | Mock remains for UI / unit tests |
| `src/services/stt/copySink.ts` | Copy-only sink (clipboard); no insert / gestures |
| `src-tauri/src/stt/` | Model catalog + explicit download, PCM buffer store (`capture/pcm_store.rs`), engine, IPC |
| Capture handoff | Clean **full** capture deposits PCM into `PcmBufferStore` and emits `capture-stopped.audio` handle metadata (no PCM over IPC) |

English-first catalog default: `whisper-tiny.en` (user must confirm download).
Also listed: `whisper-base.en`.

## Mac vs Linux / CI

| Capability | Kyle’s Mac (`--features whisper`) | Linux CI / this box (default features) |
|------------|-----------------------------------|----------------------------------------|
| List / status models | Yes | Yes |
| Explicit download / cancel | Yes (writes under app data `models/`) | Yes (same code; network allowed when user triggers) |
| Capture → PCM handle | Yes | Yes (unit-tested buffer store; full capture needs a device) |
| Real whisper.cpp transcription | **Yes** when built with `--features whisper` + cmake | **Stubbed**: `stt_transcribe` returns `engine-unavailable` explaining how to enable whisper |
| Mock STT + Copy sink | Yes (renderer) | Yes |
| Packaged-app TCC / insert | Out of scope (follow-up; BUS-12–14) | Out of scope |

Default `cargo` / `tauri` builds **do not** link whisper.cpp (keeps the PR
reviewable and avoids cmake/ggml on CI). Real transcription is opt-in.

## How Kyle runs real whisper on Mac

1. Install a C++ toolchain and **cmake** (Homebrew: `brew install cmake`).
2. From the repo:
   ```sh
   npm install
   # Dev shell with whisper linked:
   npm run tauri -- dev -- --features whisper
   ```
   Or a release build:
   ```sh
   npm run tauri -- build -- --features whisper
   ```
3. In the app (or via invoke from the webview console / a future settings UI):
   - `stt_list_models` — tiny/base English show as `missing` until downloaded.
   - **User confirms** → `stt_download_model` with `whisper-tiny.en` (or base).
   - Capture full audio → on `capture-stopped`, read `audio` handle.
   - `stt_transcribe` with `{ modelId, bufferId }` → transcript.
   - `copyTranscriptToClipboard` / existing clipboard adapter → **Copy only**.

Do **not** call download from app startup, idle timers, or engine
constructors — ADR forbids silent fetches.

### Optional: pre-fetch models without the app

Model files are standard whisper.cpp ggml weights, stored as:

`$APP_DATA/models/ggml-tiny.en.bin` (and `ggml-base.en.bin`).

Upstream URLs match `src-tauri/src/stt/catalog.rs` (Hugging Face
`ggerganov/whisper.cpp`). Prefer the in-app `stt_download_model` path so
progress events stay consistent.

## Capture → STT boundary

- BUS-9 capture events still never carry PCM bytes.
- On clean **full** (non-test) stop, samples move into `PcmBufferStore`.
- `capture-stopped` may include `audio: { id, duration_ms, sample_rate_hz }`.
- Renderer maps that with `audioHandleFromCapture` → `SttEngine.transcribe`.
- `stt_transcribe` **consumes** the buffer (single-use handle).

Test / cancelled / error paths still drop PCM without depositing.

## Deferred

- Settings UI for model pick / download progress (API is ready).
- BUS-12–14 insert / gesture delivery.
- Packaged-app TCC client identity (known BUS-9 follow-up).
- Cleanup LLM (llama.cpp) — out of MVP per ADR.
- CoreML / Metal acceleration extras — optional later; vanilla whisper-rs first.

## Verification

```sh
npm run typecheck
npm run test:unit
# Rust unit tests (no whisper feature — engine stub + store/buffer):
cd src-tauri && cargo test
```
