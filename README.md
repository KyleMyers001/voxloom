# Voxloom mock-backed UI

An interactive React and TypeScript prototype of the approved Quiet Signal
desktop design. Every transcript, device, permission, shortcut, model, and
recovery state is synthetic. No audio is captured, no native permission is
requested, and no product network service is used.

Browser / Vite-only shells keep UI state in memory (reload clears it). The
Tauri desktop shell durably persists **Settings**, **History**, and the
**Word dictionary** under the app data directory (`settings.json`,
`history.json`, `dictionary.json`). Clipboard writes occur only after an
explicit Copy activation and report failures truthfully. Development scenario controls are excluded from a
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
