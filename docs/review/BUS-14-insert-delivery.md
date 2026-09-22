# BUS-14 — Insert into intended application with truthful clipboard recovery

Branch: `bus-14-insert-delivery` (from `origin/main` including BUS-13).

Jira: [BUS-14](https://kylemyers001.atlassian.net/browse/BUS-14)

**ADR:** [`docs/decisions/native-shortcut-cancel-focus.md`](../decisions/native-shortcut-cancel-focus.md) (BUS-12) §§4–6

## What this slice is

First **implementation** of insert-preferring delivery behind a replaceable
platform adapter. macOS AX adapter snapshots the intended target at capture
start, validates at completion, inserts text-only when safe, otherwise Copy
(+ Settings toggle) with truthful Inserted / Copied / Failed messaging.

Copy sink remains the reliable floor. No Enter / command chords. No cloud STT.

## AC map

| AC | Implementation |
|----|----------------|
| 1. Intended-target/focus policy; refuse untrusted/secure/changed | `delivery/policy.ts` + `validateTarget`; macOS AX identity (pid + element id); secure → no insert |
| 2. Representative evidence notes (editor/terminal/browser/chat) | See **App/field evidence notes** below (doc OK this slice) |
| 3. Inserted / Copied / Failed only with evidence | `deliverTranscript` + `delivery.message`; history via `createDogfoodRecord({ status })` |
| 4. Clipboard fallback toggle + preserve/restore/conflict | Settings `clipboardFallback`; `shouldRestoreClipboard` / `restoreAfterPaste` for temp paste; Copy-as-delivery leaves transcript on clipboard |
| 5. Never wrong-app insert; manual recovery if history off | Validate before insert; Home “Copy last transcript” always available |
| 6. No Enter / command execution / duplicate stale completion | AX setSelectedText / setValue only; dogfood `handledAudioIdRef` unchanged |
| 7. Clipboard unavailable/change/failure → truthful messaging | Failed toasts with detail + manual recovery hint |

## App/field evidence notes (limitations)

Documented expectations for Clara Mac dogfood (not CI-provable on Linux):

| Surface | Expected | Limitation |
|---------|----------|------------|
| **Notes / TextEdit** (AXTextArea / AXTextField) | Insert via AX selected-text or value | Caret/selection replace preferred over full-value overwrite |
| **Neovim / terminal** | Often unsupported or flaky AX tree | Expect **Copied** + reason; do not claim Inserted without AX success |
| **Browser text field** | Best-effort when role is text-like / web area | ContentEditable / React fields may refuse AX set → Copy fallback |
| **Chat apps** (Messages, Slack, etc.) | Mixed; secure/password never insert | If role unsupported or changed mid-utterance → Copy, never wrong thread |
| **Secure fields** | Always skip insert | Toast: Copied/Failed — secure field |

## Emma review bar

- [ ] Delivery never claims Inserted without `insertText` success
- [ ] Secure / changed / closed never call insert on a different app
- [ ] `clipboardFallback=false` surfaces Failed + manual recovery (no silent Copy)
- [ ] Restore helpers skip on conflict and say so (no “clipboard restored” lie)
- [ ] Unit tests inject adapter failures (wrong target, secure, conflict, restore skip)
- [ ] Linux `cargo check` / typecheck / lint / unit green; macOS AX cfg-gated

## Clara Mac dogfood

| # | Step | Expected |
|---|------|----------|
| C1 | Notes focused → **global hold/latch** (do not click Home Start) → speak → release/finish | **Inserted** (or Copied if AX denied). Home Start focuses Voxloom first → often honest **Copy** |
| C2 | Password / secure field focused at start | No insert; **Copied** (fallback on) or **Failed** (off) naming secure field |
| C3 | Start in Notes, close Notes before Stop completes | **Copied — original app closed** (or Failed if fallback off); never insert elsewhere |
| C4 | Start in Notes, focus Safari mid-capture | Still targets Notes identity; if changed at completion → Copy, not Safari insert |
| C5 | Clipboard fallback off + refused target | **Failed** + last transcript Copy button works with History retention **off** |
| C6 | Confirm no trailing Enter / accidental send in chat | Text only appears; message not submitted |
| C7 | Accessibility denied | Snapshot/validate unavailable → Copy/Failed honest; no crash |
| C8 | After paste-path restore skip (if exercised) | Toast admits clipboard not restored |


### Clara note — C1 Inserted via global gesture

Home **Start capture** activates/focuses Voxloom, so `snapshotTarget()` at Start
often sees Voxloom → insert refused → **Copied** (honest). True Notes
**Inserted** requires snapshot while Notes (or another insertable app) remains
frontmost:

1. Focus Notes (or TextEdit).
2. Use the configured **global hold** (or latch) — do **not** click Home Start.
3. Speak, then release (hold) / activate again (latch).
4. Expect **Inserted** when AX succeeds; otherwise truthful **Copied** / **Failed**.

Gesture path runs the same dogfood STT → `deliverTranscript` delivery as Home
Stop (invocation-time snapshot inside `dogfood.start()`). Overlay remains
non-focus-stealing (BUS-13).

### Linux / CI verification

```sh
npm run typecheck
npm run lint
npm run test:unit
cd src-tauri && cargo check
```

Do **not** treat browser unit tests as proof of native AX insert.

## Key files

| Path | Role |
|------|------|
| `src/services/delivery/*` | Policy, messages, orchestrator, stub + Tauri adapters |
| `src-tauri/src/delivery/*` | macOS AX snapshot/validate/insert; non-macOS stubs |
| `src/services/stt/dogfoodPath.ts` | STT → `deliverTranscript` |
| `src/services/stt/useDogfoodCapture.ts` | Snapshot at start; toast from delivery evidence |
| `src/app/useShortcutGestures.ts` | Product hold/latch → dogfood start/stop (shared with Home) |
| `src/app/App.tsx` | Lifts shared `useDogfoodCapture` for Home + gesture |
| `src/domain/records.ts` | History status from delivery evidence |
| `docs/review/BUS-14-insert-delivery.md` | This review / smoke doc |

## Residual risks

| Residual | Notes |
|----------|-------|
| AX setValue may overwrite full field vs caret insert | Prefer AXSelectedText; Clara to confirm Notes/TextEdit |
| Browser / Electron / game overlays | Unsupported → Copy; may need later heuristics |
| Paste-via-⌘V path not used in v1 (AX only) | ADR allows paste without Enter; deferred if AX set fails broadly |
| Home Start while Voxloom focused | Expected **Copied**; use global hold for Notes Inserted smoke |
| Windows adapter | Stub only; replaceable boundary ready |
