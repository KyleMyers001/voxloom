# Voxloom — macOS-first local dictation (work in progress)

The Tauri desktop shell captures real microphone audio, can transcribe it
locally using an explicitly downloaded Whisper model (`--features whisper`),
and attempts to insert text into the invocation-time macOS target. When
insertion is unsafe or unavailable it can Copy instead, if clipboard fallback
is enabled; results report Inserted, Copied or Failed. The configured global
shortcut supports hold/release and double-tap latch. Native recording shows
one bottom floating waveform driven by rate-limited microphone levels (no PCM
sent to the webview); the main app no longer duplicates it. macOS permission
and Accessibility behavior require on-device verification; Windows is not
verified.

The browser / Vite-only prototype uses synthetic capture, transcription and
focused-window shortcuts; state clears on reload. The Tauri shell persists
**Settings**, **History** and the **Word dictionary** in app data
(`settings.json`, `history.json`, `dictionary.json`). Native audio retry and
saved audio retention are not implemented. Onboarding practice recognizes
shortcut gestures but does not transcribe speech. Cleanup styles, the cleanup
model and start-at-login are not functional desktop features yet. Development
scenario controls are excluded from production builds. See
`docs/review/BUS-14-insert-delivery.md` for native smoke checks and limitations.

## Browser

```sh
npm install
npm run dev
```

Open `http://localhost:1420`.

## macOS desktop

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
npm run tauri -- build --bundles app -- --features whisper
```

App path:

```text
src-tauri/target/release/bundle/macos/Voxloom.app
```

Open it, request mic access, then confirm **Voxloom** appears under
System Settings → Privacy & Security → Microphone. Details and deny/revoke
gaps: `docs/review/BUS-10-packaged-tcc.md`.

After build, confirm codesign embedded the mic entitlement (ad-hoc or
Developer ID):

```sh
npm run macos:assert-entitlements
# codesign -d --entitlements :- src-tauri/target/release/bundle/macos/Voxloom.app
```

See `docs/review/BUS-10-entitlements-codesign.md` if the dump is empty.

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
