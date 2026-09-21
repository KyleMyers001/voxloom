# BUS-10 follow-up — Dogfood on main capture UI

Branch: `bus-10-dogfood-capture-ui` (from Settings model pick on `main`).

Team lean (Clara / Emma): wire `dogfoodTranscribeAndCopy` into the **Home
Dictate** panel so Mac smoke does not need the webview console. Packaged TCC
remains deferred.

## What landed

| Piece | Behavior |
|-------|----------|
| Home → **Dictate** | Start / Stop / Cancel for full capture |
| Stop (or 120s bound) | Deposits PCM → `capture-stopped.audio` → **automatic** `dogfoodTranscribeAndCopy` |
| Settings model | Uses `settings.transcriptionModel`; no silent download |
| Missing model | Clear error: download in Settings first |
| Cancel | Discards audio; **no** STT / Copy |
| Feedback | Toast + inline status (listening / transcribing / copied / error) |
| Copy only | Still no insert / gestures |
| Native clipboard | Desktop uses `@tauri-apps/plugin-clipboard-manager` (no WebKit user-activation). Browser/mock keeps `navigator.clipboard`. |
| Soft-fail Copy | If STT succeeds but Copy fails, transcript still shows + warning toast |

## Clara smoke (Mac)

```sh
npm install
npm run tauri -- dev -- --features whisper
```

1. Settings → Speech-to-text models → **Download** tiny (if missing) → select it.
2. Home → **Dictate** → **Start capture** → speak → **Stop**.
3. Expect “Transcribing…” then “Transcript copied to clipboard” (and inline
   last transcript). No console `invoke` required. Clipboard write is native
   (not `navigator.clipboard`), so async STT after Stop must not hit WebKit
   `NotAllowedError`.
4. Repeat Start → **Cancel** → confirm no transcript / no Copy.
5. With model **missing**, Start should error with a Settings download hint
   (no silent fetch).
6. If Copy somehow fails after STT, expect transcript still shown plus a
   warning toast (“clipboard copy failed”) — not a full dogfood error.

## Verification

```sh
npm run typecheck
npm run test:unit
```

## Out of scope

- Packaged-app TCC client identity
- Insert / gestures (BUS-12–14)
- Cleanup LLM
