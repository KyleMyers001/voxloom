# BUS-10 follow-up — Settings STT model pick

Branch: `bus-10-settings-model-pick` (from async STT on `main`).

Team lean (Clara / Emma): **Settings model pick** before packaged TCC.
Async download / progress (#5) and whisper wiring (#4) are on `main`.

## What landed

| Piece | Behavior |
|-------|----------|
| Settings → Speech-to-text models | Lists catalog via `SttModelStore.list` (`stt_list_models` in Tauri) |
| Status | Shows `missing` / `available` / `downloading` / `failed` |
| Download / Cancel | Explicit buttons only; progress from async `#5` events |
| Select `modelId` | Radio → persists as `settings.transcriptionModel` |
| No silent download | Mount / app start only **list**; never calls `download` |
| Dogfood path | `dogfoodTranscribeAndCopy({ modelId, audio, clipboard })` uses the selected id → Copy sink |
| Copy / insert / TCC | Copy sink unchanged; no insert/gestures; no packaged TCC |

Defaults: `transcriptionModel = whisper-tiny.en`. Legacy simulated labels
(`Pine Voice …`) resolve to that default.

Browser / unit tests use the mock model store (no Tauri). Mac Tauri builds
use the whisper store + async download from `#5`.

## Clara smoke (Mac)

```sh
npm install
npm run tauri -- dev -- --features whisper
```

1. Open **Settings**. Confirm model list appears (`whisper-tiny.en`,
   `whisper-base.en`) as **missing** (or available if already on disk).
2. Confirm the UI stays interactive; **no download starts** on open.
3. Click **Download** on tiny. While downloading, click around Settings /
   sidebar — UI should stay responsive (async `#5`). Progress % updates.
4. Optional: **Cancel download** mid-flight → status returns to missing.
5. Select a model (radio). Confirm “Selected for transcription”.
6. After available: full capture → **stop** (deposit) → dogfood
   `stt_transcribe` / `dogfoodTranscribeAndCopy` with
   `settings.transcriptionModel` → Copy only.

## Verification

```sh
npm run typecheck
npm run test:unit
cd src-tauri && cargo test
```

## Out of scope (still deferred)

- Packaged-app TCC client identity
- Insert / gestures (BUS-12–14)
- Cleanup LLM
