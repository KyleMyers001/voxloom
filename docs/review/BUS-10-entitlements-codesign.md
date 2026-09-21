# BUS-10 follow-up — Entitlements codesign

Branch: `bus-10-entitlements-codesign` (after packaged TCC on `main`,
squash `a8f572d`).

## Why

Clara’s Mac smoke on the packaged-TCC build showed:

| Check | Result |
|-------|--------|
| Info.plist / TCC display name | **PASS** — Privacy → Microphone lists **Voxloom** |
| `codesign -d --entitlements :-` | **FAIL** — empty / no dump |
| Identifier | `voxloom-…` hash (linker ad-hoc), not `com.voxloom.prototype` |

Root cause: `bundle.macOS.entitlements` + `hardenedRuntime` were set, but
**no `signingIdentity`**. Tauri’s bundler only runs `codesign` when a
keychain identity resolves (`signingIdentity` or `APPLE_CERTIFICATE*`).
With neither present, signing is skipped silently; the Mach-O keeps the
Apple Silicon **linker** ad-hoc signature, which does **not** embed
`Entitlements.plist`.

Upstream behavior (tauri-bundler `app.rs` / `sign.rs`):

- `keychain(None)` → `Ok(None)` → no `sign()` call
- `sign()` is what passes `--entitlements` (and `--options runtime`)

## Fix

| Piece | Change |
|-------|--------|
| `bundle.macOS.signingIdentity` | `"-"` (ad-hoc pseudo-identity) |
| `Entitlements.plist` | unchanged (`com.apple.security.device.audio-input`) |
| `scripts/macos-assert-entitlements.sh` | Mac verify (+ optional `--repair`) |
| `npm run macos:assert-entitlements` | wrapper for Clara |

`signingIdentity: "-"` makes Tauri run:

```text
codesign --force -s - --options runtime --entitlements Entitlements.plist …
```

`APPLE_SIGNING_IDENTITY` still overrides this for a real Developer ID later
(CI / distribution). Keep `"-"` in config so local Mac builds stay correct
without env vars.

No permission-request API changes.

## Build (Mac)

```sh
npm install
npm run tauri -- build --bundles app
# or with whisper:
npm run tauri -- build --bundles app -- --features whisper
```

App path:

```text
src-tauri/target/release/bundle/macos/Voxloom.app
```

## Clara verification (required)

From repo root, after build:

```sh
APP=src-tauri/target/release/bundle/macos/Voxloom.app

# 1) Identity / team / flags
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E 'Identifier|Authority|TeamIdentifier|Flags|Signature'

# Expect roughly:
#   Identifier=com.voxloom.prototype   (preferred)
#   Authority=ad-hoc                   (or "signed by …" with Dev ID)
#   Flags=0x10000 (runtime)            when hardened runtime applied

# 2) Embedded entitlements (must dump audio-input)
codesign -d --entitlements :- "$APP"

# Expect a plist containing:
#   <key>com.apple.security.device.audio-input</key>
#   <true/>

# 3) Scripted assert (same checks; --repair only if dump is empty)
npm run macos:assert-entitlements
# npm run macos:assert-entitlements -- --repair
```

Also re-confirm Privacy → Microphone still lists **Voxloom** (packaged TCC
identity from the prior slice).

## Residual risks

| Risk | Notes |
|------|--------|
| Gatekeeper / “unidentified developer” | Ad-hoc (`-`) does **not** notarize. Local `open` / right-click Open is fine for dogfood; distribution still needs Developer ID + notarization. |
| Identifier still not `com.voxloom.prototype` | Tauri’s `codesign` does not always pass `-i`. Bundle `CFBundleIdentifier` remains `com.voxloom.prototype` for TCC. If Identifier dumps as a hash, run `npm run macos:assert-entitlements -- --repair` (passes `-i`). |
| Real Apple identity | For Team ID / Gatekeeper-clean builds, set `APPLE_SIGNING_IDENTITY` (or replace `signingIdentity`) with a Developer ID Application cert; keep the same `entitlements` path. |
| Linux forge | Cannot run `codesign`. Unit tests only assert config + script presence. |

## Out of scope

- Whisper-featured `.app` dogfood (next smoke after this lands)
- Notarization pipeline / CI certificate import
- Deny/revoke TCC flows (still human Mac; see packaged-tcc doc)

## Verification (this branch, Linux)

```sh
npm run typecheck
npm run lint
npm run test:unit
```
