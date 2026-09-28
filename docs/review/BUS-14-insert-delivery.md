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

### Clara failure — stuck waveform after hold release (a161e1f)

On tip `a161e1f`, after global hold **release** the desktop waveform overlay
stayed visible until the app was killed. Hold-finish promoted dictation to
`processing` and awaited dogfood terminal phase to clear; if `dogfood.stop` /
STT / deliver failed or raced (stop before capture session owned), listening|
processing never cleared → overlay stuck.

**Fix (6f1ada8):** finish/cancel/error always tear down overlay + listening|
processing (`dictation.cancel`) via try/finally — clear **immediately on
release**, and again in `finally` after `dogfood.stop`.

### Clara failure — 2nd/3rd hold stuck (6f1ada8)

On tip `6f1ada8`, **1st** hold→release cleared overlay OK; **2nd or 3rd** hold
left waveform stuck until process kill. Home still showed **Stop** (dogfood
capture never stopped) ⇒ `hold-finish` / `endGestureCapture` never ran.
Clicking in-app **Stop** returned Home to Start (capture ended) but **overlay
stayed** (dictation listening|processing not torn down on dogfood terminal).

**Root cause:** Mac hold-release watch uses optimistic `holdWatchMonitoring`
(Carbon `Released` ignored while armed). A fire-and-forget `disarm()` from
hold N could complete **after** hold N+1 `arm()`, killing the new Rust watch
while TS still ignored Carbon Released → no poll/tap finish → no
`endGestureCapture` / `dogfood.stop`. Separately, dogfood terminal via Home
Stop did not force overlay hide when gesture finish never ran.

**Fix:** serialize hold-watch arm/disarm with a generation queue so a late
disarm cannot kill the next session’s watch; fully disarm monitoring on
finish so the next press re-arms cleanly; on dogfood terminal (success/error/
cancel) always `dictation.cancel` + force overlay sync hide; new hold clears
leftover listening|processing when dogfood is already terminal.

### Clara re-smoke (after multi-session fix)

| # | Step | Expected |
|---|------|----------|
| R1 | Notes focused → **two** global hold→release cycles in a row | Each **press**: overlay **shows**; each **release**: overlay **clears** + Home **Start** (no kill, no click Stop) |
| R1b | Optional third hold→release | Same — overlay on press, clear + Start on release |
| R2 | Then Notes Inserted smoke (hold while Notes focused) | Toast **Inserted** (or truthful Copied/Failed); History row matches |
| R3 | If overlay ever sticks: in-app Stop | Capture ends **and** overlay clears (not Stop-only) |

**Gate:** Clara must pass **two** clean hold→release (Start + overlay clear) before Notes Inserted (R2).

### Clara failure — c9e0df5 still FAILS R1

On tip `c9e0df5` (generation-serialized arm/disarm alone): **1st** hold→release OK;
**2nd** hold showed **no overlay at all**, Home stayed on **Stop** (dogfood never
stopped) ⇒ `hold-finish` / `endGestureCapture` never ran between sessions. Kyle
clicks in-app Stop to recover. Root: while `holdWatchMonitoring` was true, **all**
Carbon `Released` edges were ignored; finish depended only on Rust poll/tap. If
the 2nd-session watch missed release, finish never fired. Next `hold-start` was
silently ignored as `isDogfoodBusy` → no overlay.

**Fix (this SHA):** (1) suppress Carbon Released only during a short post-arm
grace (~80ms); after grace Carbon calls `released` + disarm as **backup** finish;
(2) on new `hold-start`, if prior dogfood is still busy / leftover listening,
`dogfood.cancel` + overlay clear **before** starting (never ignore as busy);
(3) keep dogfood terminal + Home Stop force-clearing overlay; (4) arm failure
clears monitoring immediately.

### Kyle failure — dbe5748 still FAILS R1 (root cause found)

On tip `dbe5748`: **1st** hold shows overlay and clears on release; **2nd** hold
shows **no overlay**, Home stays on **Stop**. Same symptom as c9e0df5, so the
hold-release watch was never the cause.

**Root cause (TS, deterministic — not a Mac race):** the "dogfood terminal ⇒
clear overlay" effect in `useShortcutGestures` depended on
`[dogfood.phase, dictation, state.dictation]` and ran whenever it was
*currently* terminal. After hold 1 delivers, `dogfood.phase` stays
`"success"` until the next `start()`. Hold 2's `dictation.start()` commits a
new `listening` run while the phase is still `"success"`, so the effect
re-ran and immediately `dictation.cancel`led the new run: overlay never
showed, the `cancelled` transition then `resetPartial()`ed the gesture
machine, the physical release found no hold in progress (`hold-finish` never
fired), `dogfood.stop` never ran ⇒ Home stuck on Stop. Hold 1 only worked
because the phase started at `"idle"`. The multi-hold unit tests missed it
because they never re-rendered the hook and kept `phase: "idle"`.

Secondary: `useDogfoodCapture` was not session-safe. A hold started while the
previous utterance was still `"transcribing"` was `cancel()`ed by hold-start,
yet the in-flight STT still resolved and set `phase = "success"` mid-session —
the same terminal edge would then kill the new hold.

**Fix (this SHA):**
1. Terminal teardown is **edge-triggered** on the phase *transition* (tracked
   in a ref) with `[dogfood.phase]` as the only dependency.
2. `endGestureCapture`'s post-stop teardown cancels only the run it finished
   (`runId`-scoped), never a newer run.
3. hold-start abandons leftover `"recording"` dogfood only; an in-flight
   `"transcribing"` session is left to finish. Its completion still delivers,
   records history and toasts, but a session counter stops it from touching
   the newer session's phase/transcript.
4. Regression tests re-render the hook like the real app across 3 hold cycles
   with the phase parked at `"success"`, plus the transcribing-overlap case.

The c9e0df5 / dbe5748 hold-watch changes (serialized arm/disarm, Carbon
Released backup after grace) are kept as defence in depth; they are no longer
required for R1 and could be simplified once R1 passes on device.

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
| Stuck overlay after release (pre-fix) | Fixed: unconditional tear-down on finish/cancel/error (try/finally) |
| 2nd/3rd hold stuck (6f1ada8) | Serialized arm/disarm alone insufficient (c9e0df5 still failed R1) |
| 2nd hold no overlay + Home Stop (c9e0df5) | Fixed: Carbon Released backup after grace + force-stop leftover busy on hold-start |
| 2nd hold no overlay + Home Stop (dbe5748) | Fixed: terminal-teardown effect was level-triggered on stale phase; now edge-triggered + session-guarded dogfood |
| Windows adapter | Stub only; replaceable boundary ready |

## Daily dictation restart (PLAN-20260928-163552; Mac QA pending)

A fast re-hold could reach `useDogfoodCapture.start()` while
`useCaptureState` still owned the previous request. `startFullCaptureSession`
returned silently; the UI then claimed “recording” without a new microphone
session. It now acknowledges started/ended/busy/error, and dogfood only
announces recording after a confirmed start. A stop requested while start is
pending is still honored; terminal-before-start-reply never resurrects a run.
Native History does not offer a retry without retained audio; failed rows with
text can be copied. Existing older rows with a fictional retry expiry are not
presented as retryable in the desktop shell.

Local checks: typecheck, lint, build, 293 TS unit tests, Rust `cargo check`
(4 pre-existing warnings) and 129 Rust library tests passed. Browser release
onboarding and two mock retry E2Es passed using the installed external
Playwright browser cache. Default E2E scripts need a browser at the configured
repo-local `.playwright-browsers` path; the remaining screenshot-writing tests
were not run because they overwrite tracked baseline images.

**Not yet verified on device:** real fast re-hold and three-cycle Mac gesture
smoke, latch/Home Stop, Notes Inserted vs Copy, browser/terminal/chat targets,
secure field, changed target, denied permissions and clipboard failure.
Re-run R1–R3 above with the Whisper-featured Tauri shell; record actual
application, gesture, overlay, capture and delivery outcomes. Do not mark this
slice native-validated until those checks pass. The Carbon monitor defenses
remain unchanged.
