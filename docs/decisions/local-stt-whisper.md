# ADR: Local STT runtime — whisper.cpp first

- **Status:** Accepted (BUS-8)
- **Date:** 2026-09-21
- **Context:** Voxloom needs on-device speech-to-text after native capture (BUS-9), without silent cloud upload.

## Decision

Use **whisper.cpp** as the first local STT runtime for personal MVP dictation.

- English-first models; explicit user-triggered download/update (no silent fetches).
- Capture pipeline hands PCM (or an equivalent local buffer) to an STT adapter behind a stable TypeScript/Rust contract; UI stays on mock adapters until BUS-10 wires the real path.
- **Optional** post-dictation cleanup LLM (e.g. llama.cpp) is **deferred** — not part of the first dogfood slice.

## Consequences

- BUS-10 implements model lifecycle + transcription ending in **Copy** (clipboard) before gesture/insert work (BUS-12–14).
- Cross-platform: Mac-first packaging is OK; keep the STT port/adapter boundary free of UI assumptions.
- Reject any path that uploads audio or transcripts without an explicit, visible user action.

## Alternatives considered

- Cloud STT APIs — rejected for local-first / privacy MVP.
- Starting with a cleanup LLM in-loop — deferred until raw transcription is reliable daily.
