# BUS-10 STT scaffold (interfaces only)

Branch: `bus-10-stt-scaffold`.

Emma / Clara / Kyle agreed this slice is **adapter contracts + stubs + Copy
sink only**. It does **not** wire capture → whisper end-to-end and does
**not** add native whisper.cpp.

ADR: `docs/decisions/local-stt-whisper.md` (whisper.cpp first; no silent
model download; no silent upload; Copy before insert).

## Stubbed in this PR

| Path | Role |
|------|------|
| `src/services/stt/types.ts` | PCM handle, transcript, model info, download progress, `SttError` |
| `src/services/stt/contracts.ts` | `SttModelStore`, `SttEngine` (no UI/Tauri) |
| `src/services/stt/mockStt.ts` | Deterministic mock engine + in-memory model store with explicit `download` progress |
| `src/services/stt/copySink.ts` | Transcript → `ClipboardAdapter.copy` helper |
| `src/services/stt/index.ts` | Thin re-exports |
| `tests/unit/stt/*.test.ts` | Mock STT + copy sink unit coverage |

`SttModelStore.download` / `cancel` are documented as **explicit user
intent only** — callers must not start downloads from idle lifecycle or
app start.

## Deferred (not in this PR)

- Real whisper.cpp / Tauri STT commands
- Capture pipeline → `AudioBufferHandle` → `SttEngine.transcribe`
- Model file I/O, checksums, disk paths
- Silent or background model fetch (rejected by ADR)
- Insert / gesture delivery (BUS-12–14); Copy sink is the only sink here
- Cleanup LLM (llama.cpp) — out of MVP per ADR

## Verification

`npm run test:unit` (vitest) covers mock store progress, cancel, deterministic
transcript, and copy-sink clipboard writes.

## Follow-up

Real whisper wiring: `docs/review/BUS-10-whisper.md`.
