# ADR: Local STT runtime — whisper.cpp first

- **Status:** Accepted (BUS-8); first written record 2026-09-21
- **Date:** 2026-09-21
- **Context:** Voxloom needs on-device speech-to-text after native capture (BUS-9), without silent cloud upload.

## Decision

Use **whisper.cpp** as the first local STT runtime for personal MVP dictation.

- English-first models; explicit user-triggered download/update (no silent fetches).
- **Reject silent model downloads** — model files are fetched or updated only after a clear, visible user action (same bar as no silent upload).
- Capture pipeline hands PCM (or an equivalent local buffer) to an STT adapter behind a stable TypeScript/Rust contract; UI stays on mock adapters until BUS-10 wires the real path.
- **Optional** post-dictation cleanup LLM (e.g. llama.cpp) is **deferred** — not part of the first dogfood slice.

## Consequences

- BUS-10 implements model lifecycle + transcription ending in **Copy** (clipboard) before gesture/insert work (BUS-12–14).
- Cross-platform: Mac-first packaging is OK; keep the STT port/adapter boundary free of UI assumptions.
- Reject any path that uploads audio or transcripts without an explicit, visible user action.

## Extension: optional Parakeet Core ML backend

Parakeet TDT 0.6B v2 (English) and v3 (multilingual) are optional additional
backends, not a replacement or default switch. The Swift helper uses a pinned
FluidAudio runtime and explicitly provisioned, verified local model sets. It
must use the local-only loader and must not download or repair model assets
while preparing or transcribing.

The helper targets Apple Silicon/macOS 14+, independently of the parent app's
macOS 13.1/Intel Whisper compatibility. Model preparation overlaps capture;
selection is frozen at activation and inference still operates on the completed
clip. Initial worker lifetime is one process per recording, with bounded
Parakeet-only admission. This does not introduce a global Whisper scheduler.
Admission keeps one active runner (reserved through kill/reap), at most one FIFO
pending recording, and at most 64 unconsumed jobs. Live job/request ownership is
never evicted. Separately, the native registry retains the most recent 4096
distinct terminal request IDs in FIFO order: consumed results and cancellations,
including cancellation before preparation. Repeated release does not refresh
that order. Recent IDs cannot be reused; once evicted, an otherwise non-live ID
can be admitted again. This is a finite replay window, not lifetime single-use:
reusing an expired ID cannot distinguish an arbitrarily late same-ID cancel.
The frontend therefore continues to generate a fresh random UUID per recording.
Exact-ID cancellation cannot cancel a distinct successor. Main-renderer retirement
advances the native epoch and clears the replay window; stale-epoch calls still
refuse, and Settings retirement does neither. Active reservations survive main
retirement until their exact runner has reaped its child.
Dictionary, optional cleanup, History and the existing delivery/target contract
remain downstream of recognition. Parakeet filtering is backend-specific;
Whisper's decoder and silence/tail/text filtering remain unchanged.

## Alternatives considered

- Cloud STT APIs — rejected for local-first / privacy MVP.
- Starting with a cleanup LLM in-loop — deferred until raw transcription is reliable daily.
