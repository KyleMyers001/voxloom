# BUS-10 follow-up — Packaged-app TCC identity

Branch: `bus-10-packaged-tcc` (from dogfood Dictate on `main`).

Goal: make a local macOS `.app` show as **Voxloom** / `Voxloom.app` under
System Settings → Privacy & Security → Microphone, instead of the
`tauri-dev` helper / host terminal (e.g. WezTerm) that owns mic identity
during `npm run tauri -- dev`.

This slice configures the Tauri macOS bundle and documents Clara/Kyle
smoke. It does **not** claim deny/revoke flows are fixed.

## Config that landed

| Piece | Location | Purpose |
|-------|----------|---------|
| `productName`: `Voxloom` | `src-tauri/tauri.conf.json` | Finder / dock / TCC display name |
| `identifier`: `com.voxloom.prototype` | same | Stable bundle ID (unchanged) |
| Window title `Voxloom` | same | Matches product name in packaged UI |
| `bundle.active`: `true`, `targets`: `["app"]` | same | `tauri build` emits a `.app` |
| Icon set (incl. `icon.icns`) | `src-tauri/icons/` | Proper `.app` Resources icon |
| `NSMicrophoneUsageDescription` | `src-tauri/Info.plist` | Required usage string for mic prompt |
| `CFBundleDisplayName` / `CFBundleName` | same | Explicit **Voxloom** in merged Info.plist |
| `com.apple.security.device.audio-input` | `src-tauri/Entitlements.plist` | Hardened-runtime mic / Core Audio input |
| `bundle.macOS.entitlements` + `hardenedRuntime` | `tauri.conf.json` | Wire entitlements into signing |

Tauri merges `Info.plist` with generated keys (executable name, version,
bundle ID). Do not point `entitlements` at `Info.plist` — privacy strings
and device entitlements are different files.

## Permission request API (packaged vs `tauri-dev`)

No separate packaged code path was required. Mic query/request still uses
AVFoundation (`AVCaptureDevice` authorizationStatus / requestAccess) via
`src-tauri/src/capture/permission.rs`, invoked from:

- `capture_request_permission` / `capture_query_permission` (Settings /
  Onboarding), and
- the capture worker before opening a stream (Dictate / mic test).

What changes under a real `.app` is **TCC client identity**: macOS
attributes the prompt and the Privacy list entry to the signed (or
ad-hoc-signed) bundle, not to the parent terminal that launched
`tauri-dev`. The same IPC commands work in both contexts once the usage
description ships inside `Contents/Info.plist`.

## How to build a local `.app` (Mac)

Prerequisites: Xcode CLT, Rust stable, Node, and for real STT:
`brew install cmake`.

From the repo root:

```sh
npm install

# Packaged app with local whisper.cpp (Clara dogfood / STT smoke)
npm run tauri -- build --bundles app -- --features whisper

# Packaged app without whisper linkage (mic / TCC identity only)
npm run tauri -- build --bundles app
```

Output (typical):

```text
src-tauri/target/release/bundle/macos/Voxloom.app
```

Optional: open without copying into `/Applications`:

```sh
open src-tauri/target/release/bundle/macos/Voxloom.app
```

Dev (not packaged — expect WezTerm / helper identity in TCC):

```sh
npm run tauri -- dev -- --features whisper
```

### Quick Info.plist check (before smoking)

```sh
plutil -p src-tauri/target/release/bundle/macos/Voxloom.app/Contents/Info.plist \
  | grep -E 'CFBundle(Display)?Name|CFBundleIdentifier|NSMicrophone'
```

Expect roughly:

- `CFBundleDisplayName` / `CFBundleName` → `Voxloom`
- `CFBundleIdentifier` → `com.voxloom.prototype`
- `NSMicrophoneUsageDescription` → the local-transcription string

If the `.app` was codesigned (ad-hoc or Developer ID), confirm the
hardened-runtime audio entitlement:

```sh
codesign -d --entitlements :- \
  src-tauri/target/release/bundle/macos/Voxloom.app 2>&1 \
  | grep -A1 audio-input || true
```

## Clara smoke — mic identity

1. Build with `--bundles app` (and `--features whisper` if also checking
   Dictate→STT→Copy).
2. Quit any prior `tauri-dev` / WezTerm-owned capture session.
3. Launch **Voxloom.app** (not `tauri-dev`).
4. First mic use (Settings → Request access, Onboarding, or Dictate Start
   while status is NotDetermined) should prompt with the Voxloom usage
   string.
5. Open **System Settings → Privacy & Security → Microphone**.
6. Confirm an entry for **Voxloom** (or `Voxloom.app`), **not** WezTerm /
   Terminal / a bare helper binary.
7. Toggle Allow → retry Dictate or mic test; expect capture to proceed when
   Authorized.

Dictate→STT→Copy steps remain as in `BUS-10-dogfood-capture-ui.md`, but
run them from the packaged `.app`.

## Explicitly still open (BUS-9) — do not treat as fixed

| Gap | Status |
|-----|--------|
| Deny after Allow | User must flip the Microphone toggle (or remove the app) in System Settings. Voxloom does **not** reset TCC or ship a revoke/reset API. |
| Revoke / re-prompt after Deny | macOS will not re-show the system prompt while Denied/Restricted. UI should keep directing the user to System Settings. No in-app “Reset permission” was implemented. |
| Dev vs packaged dual entries | After dogfooding both `tauri-dev` and `.app`, Privacy may list both the terminal/helper **and** Voxloom. That is expected; clean up manually in System Settings if needed. |
| Real unplug / default-device timing | Still a foreground CoreAudio verification gap from BUS-9 Slice C. |

Forge / CI on Linux cannot open a mic or mutate TCC. Identity and
deny/revoke remain human Mac checks.

## Out of scope

- Insert / gestures (BUS-12–14)
- Windows packaging
- Notarization / Developer ID distribution pipeline
- Changing the stable bundle ID (`com.voxloom.prototype`)

## Verification (this branch, non-Mac host)

```sh
npm run typecheck
npm run lint
# Optional: npm run test:unit
# macOS only: npm run tauri -- build --bundles app -- --features whisper
```
