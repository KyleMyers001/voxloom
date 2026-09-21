# BUS-10 follow-up — async STT download / transcribe

Branch: `bus-10-async-stt` (from whisper wiring on `main`).

Emma / Clara follow-up #2 after dogfood BUS-10: **do not freeze the UI** while
models download or whisper runs. Packaged TCC remains out of scope; Settings model-pick is a separate
follow-up (`bus-10-settings-model-pick`).

## What changed

| Piece | Behavior |
|-------|----------|
| `stt_download_model` | `async` command + `spawn_blocking` — ureq I/O off the IPC/UI thread |
| `stt_transcribe` | `async` command + `spawn_blocking` — whisper / stub off-thread |
| `stt_cancel_download` | Still sync + cheap so it can interrupt an in-flight download |
| Progress | Same `stt:download-progress` events; ratio `1.0` only after the file is finalized |
| Contracts | Explicit `modelId`, no silent download, Copy-only sink unchanged |
| JS adapter | Still `await invoke(...)`; listens for progress **before** invoke; completion is invoke resolution, not progress alone |

Capture deposit / stop / cancel paths are untouched (still covered by existing
coordinator + `PcmBufferStore` tests).

## Clara smoke — UI stays responsive

On Kyle’s Mac (`npm run tauri -- dev -- --features whisper`):

1. Open the app; interact with the mock UI (click, scroll) to confirm the
   window is live.
2. Trigger an **explicit** model download (`whisper-tiny.en` via invoke or a
   future settings control — not on app start).
3. **While bytes are downloading**, keep clicking / focusing controls in the
   webview. The UI should remain interactive; progress events may still fire.
4. Optionally invoke `stt_cancel_download` mid-flight — download should error
   `cancelled` and leave no final model file. Cancel when already present /
   idle should still succeed (no-op).
5. After a successful download: capture → **stop** (deposit) →
   `stt_transcribe` with `{ modelId, bufferId }`. During a longer run, the
   webview should not hard-freeze; then Copy the transcript (Copy-only sink).

Linux / CI builds without `--features whisper` still exercise async download
and the engine-unavailable stub for transcribe; they do not prove real whisper
latency.

## Verification

```sh
npm run typecheck
npm run test:unit
cd src-tauri && cargo test
```

## Deferred (still not this PR)

- Packaged-app TCC client identity
- Settings UI for model pick / download progress → see `docs/review/BUS-10-settings-model-pick.md`
- Insert / gestures (BUS-12–14)
