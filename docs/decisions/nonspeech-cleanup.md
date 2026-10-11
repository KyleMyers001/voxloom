# ADR: Non-speech tag and silence-hallucination cleanup (BUS-23)

- **Status:** Proposed (BUS-23)
- **Date:** 2026-10-11
- **Context:** Whisper emits non-speech tags (`[BLANK_AUDIO]`, `[Music]`, `(coughs)`, `♪`) and, on silent or near-silent clips, hallucinated phrases ("Thank you.", "Thanks for watching!"). These must not reach the focused app or the clipboard.

## Decision

Clean in **Rust, inside `stt_transcribe`**, after whisper and before the result is returned to the renderer. Both delivery paths (AX insert and the Copy floor) then receive the same cleaned `text`, and the later LLM cleanup pass (BUS-16) runs on cleaned text.

Pipeline (`src-tauri/src/stt/pipeline.rs`):

1. Validate PCM (unchanged rules).
2. **RMS gate.** If RMS and peak are both below `silenceGateRms` / `silenceGatePeak`, skip whisper and return empty text with `dropped: "silent-audio"`.
3. **VAD seam** (`gate::VoiceActivityDetector`). When `vad` is enabled and the detector says "no speech", skip whisper (`no-speech`). There is no backend yet (see Follow-ups).
4. **Whisper** with `suppress_non_speech_tokens`, `suppress_blank` and `no_speech_thold` (default 0.6) from the config.
5. **Text cleanup** (`stt/cleanup/`, pure functions):
   - Strip `[...]`, `(...)` and `*...*` only when the normalized inner words are on the sound list. Asides like `(I think)` and `[sic]` stay.
   - Strip ♪ ♫. Collapse identical tags repeated back to back.
   - Tidy whitespace and orphan punctuation.
   - Remove trailing YouTube outros, but only when real dictation precedes them.
   - Drop the whole output only when every sentence is a known hallucination **and** the clip is quiet (`quietRms` / `quietPeak`). Phrases are never removed mid-text.

`TranscriptDto` now carries `rawText` (the whisper output) and `dropped` (the reason). The renderer delivers `text`. When it is empty, delivery already refuses to insert or copy, and the status reads "Failed — no speech detected; nothing inserted or copied". It never claims Inserted or Copied. History rows store `rawText` only when it differs from `text`. It lives in the same row, so transcript retention (`off` / `30-days` / `forever`) applies unchanged. A fully dropped output creates no History row, but its raw text stays on the in-session transcript.

All thresholds live in `SpeechFilterConfig` (serde defaults; partial overrides via the optional `filter` argument of `stt_transcribe`).

## Follow-ups

- **Silero VAD backend.** It needs an ONNX runtime (`ort`, a native library of tens of MB) plus a ~2 MB model, adds packaging and codesign work, and can only be verified on macOS. Alternatively, a newer whisper-rs / whisper.cpp ships built-in Silero VAD. The trait seam and the `vad` flag are in place, and `NoVad` (no opinion) is the default.
- Expose the filter settings in the Settings UI if tuning is needed.
- Threshold tuning on real Mac recordings.
