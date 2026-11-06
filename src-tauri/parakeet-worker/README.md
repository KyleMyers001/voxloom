# Parakeet Core ML worker

`voxloom-parakeet-worker` is a fresh-process, one-recording helper for macOS 14+
Apple Silicon. It accepts an already-provisioned **local** v2 or v3 directory.
It never calls FluidAudio's repository-resolution, download, convenience-load or
recovery APIs. The production path is `AsrModels.loadLocal` →
`AsrManager.loadModels` → `AsrManager.transcribe` with a fresh `TdtDecoderState`.
Dictionary boosting loads the local CTC 110M set with `CtcModels.loadDirect` and
`CtcTokenizer.load(from:)`, then rescoring uses `CtcKeywordSpotter` and
`VocabularyRescorer`. It does not use `VocabularyBoostingSession`, which reads
the tokenizer from FluidAudio's own cache.

## Build and weight-free verification

Use Swift tools 6.2 or newer. FluidAudio is pinned by full revision in both
`Package.swift` and `Package.resolved`, with `traits: []` disabling TTS,
diarization and NeMo linking/resources. SwiftPM may still fetch the dependency's
declared NeMo binary **code artifact** during package resolution; it is not a
model, is not linked, and must not be bundled. Common FluidAudio model-registry
constants and networking code remain in the ASR library; the worker does not
invoke the networking loaders.

```sh
swift package resolve
swift test --disable-automatic-resolution
swift build -c release --product voxloom-parakeet-worker --disable-automatic-resolution
swift build -c release --product parakeet-worker-fixture --disable-automatic-resolution
BIN="$(swift build -c release --show-bin-path)"
PARAKEET_WORKER="$BIN/voxloom-parakeet-worker" \
PARAKEET_FIXTURE="$BIN/parakeet-worker-fixture" python3 Tests/protocol_tests.py
```

Package only the production worker, **not** the test fixture or test bundles.
The worker has no resource bundles to copy. Resolve the binary directory with
`--show-bin-path`; SwiftPM build-directory layouts vary across toolchain versions.
The macOS deployment target is 14. An x86_64 compatibility build may compile,
but the production loader explicitly refuses that architecture. This does not
add Intel Parakeet support to Voxloom or change Intel/macOS 13 Whisper support.

Tests inject the recognizer only at the model boundary; the subprocess fixture
uses the same framing, native pipe reader, session and watchdog as production.
Missing/empty-directory tests also execute the real local loader without weights.
No test downloads model weights. Real loaded-model inference, accuracy, memory,
latency and macOS 14 runtime acceptance require separately approved models/tests.

## Protocol v1

Stdin/stdout control frames are a little-endian UInt32 length followed by UTF-8
JSON, with at most 65,536 JSON bytes. No logs are written to the protocol pipe.

1. `load`: `protocolVersion: 1`, `requestId`, `modelVersion: "v2" | "v3"`,
   `modelDirectory` (absolute native path), and optional `vocabularyDirectory`
   (absolute path of the CTC 110M set; without it, no boosting). Loading begins
   immediately. A missing directory is `model-missing`; a CTC set that Core ML
   cannot load means no boosting, not a failed recording.
2. `ready`: same version and request ID.
3. `transcribe`: same version/ID, `sampleRateHz: 16000`, `sampleCount`, optional
   `vocabulary` (at most 256 dictionary words, each 1–128 UTF-8 bytes with no
   control characters), followed by exactly `sampleCount * 4` bytes of
   little-endian mono Float32 samples.
4. `result`: same version/ID, `text`, `rawText`, `language`, `dropped: null`.
   v2 language is `"en"`; v3 language is `null` (no detected-language invention).
   The process exits after this single reply. Oversized replies fail, not truncate.

IDs are 1–128 ASCII letters/digits or `-_.:`. Samples must be finite, in [-1, 1],
and number 1–1,920,000 (120 seconds). Header lengths, counts, IDs and sample values
are checked before model inference; counts are checked before PCM allocation.
Errors use only contract codes and a fixed generic message, never dependency
error descriptions, audio, model paths or speech.

The parent **must keep stdin open through the reply**. Closing it is cancellation,
not an end-of-audio marker. A dedicated reader terminates the process on EOF,
including while synchronous Core ML loading or prediction is blocked. Bytes
beyond the one recording are rejected. The Rust supervisor remains responsible
for cancellation, kill/reaping and its own finite IPC deadlines.

An independent native watchdog enforces 180-second initial-input/audio-read waits,
120-second loading, 120-second inference, and 5-second writes. These are hard
process deadlines, not cooperative task cancellation; deadline expiry exits 1.
EOF exits 0 without publishing a late result. Protocol errors publish a bounded
error reply and exit normally; a malformed initial header uses an empty error ID
rather than reflecting untrusted bytes.

FluidAudio logging is restricted to `.fault` with console mirroring disabled
(the pinned source has no fault call sites). Original stdout is duplicated for
protocol writes; ordinary stdout/stderr are redirected to `/dev/null` before
model construction, preventing dependency console output from corrupting IPC or
leaking speech/paths. This does not claim control over Apple's internal unified
logging or prove network isolation by an OS sandbox.
