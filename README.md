# Voxloom mock-backed UI

An interactive React and TypeScript prototype of the approved Quiet Signal
desktop design. Every transcript, device, permission, shortcut, model, and
recovery state is synthetic. No audio is captured, no native permission is
requested, and no product network service is used.

All state is held in memory and **resets when the page or desktop window is
reloaded**. Clipboard writes occur only after an explicit Copy activation and
report failures truthfully. Development scenario controls are excluded from a
normal production build; the mock dictation and onboarding flows remain usable.
The default `Ctrl + Shift + Space` gesture works only while Voxloom is focused:
hold and release, or rapidly double-tap to latch and activate once more to stop.

## Browser

```sh
npm install
npm run dev
```

Open `http://localhost:1420`.

## macOS desktop

With the Rust and macOS build toolchains installed:

```sh
npm run tauri dev
```

The Tauri shell has no application capabilities or native commands. Windows is
not verified by this repository.



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

## Verification

```sh
npm run typecheck
npm run lint
npm run test:unit
npm run build
npm run test:e2e
```
