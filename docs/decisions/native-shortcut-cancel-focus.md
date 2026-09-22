# ADR: Native shortcut, cancellation, and focus / insertion strategy

- **Status:** Decided (provisional where OS automation blocks live proof)
- **Date:** 2026-09-22
- **Ticket:** [BUS-12](https://kylemyers001.atlassian.net/browse/BUS-12)
- **Feature IDs:** CAP-01, CAP-02, CAP-03, CAP-04, CAP-07, INS-02, INS-05, ONB-03, ONB-06
- **Enables:** BUS-13 (overlay / native gesture wiring), BUS-14 (insert polish)

## Context

Voxloom needs one global dictation shortcut with hold and latch gestures, clear
cancellation, an intended insertion target across app focus changes, and a
truthful clipboard fallback. Today the product ships a **focused-window mock**
only. This record settles the macOS-first native strategy so later tickets can
implement without re-litigating policy.

**Verification bar:** Decision evidence may include targeted macOS feasibility
trials and documented blocked OS automation. Focused-window browser / Vite
prototype behavior is **not** native proof.

## Mock today vs native target

| Layer | What exists today | Native target (this ADR) |
|-------|-------------------|---------------------------|
| Gesture source | `src/services/shortcutController.ts` on `document` keydown/keyup | OS-wide registration for the configured combo |
| Timings | Hold **320 ms**, double-tap latch window **260 ms** | Same numbers as **provisional native targets** (below) |
| Collision | Hard-coded / simulated in Settings UI | Real register-or-revert + last-known-good |
| Cancel | Dialog Escape (UI-scoped); DEV / capture cancel paths | Scoped cancel only — **no** global Escape grab |
| Delivery | Copy sink (`src/services/stt/copySink.ts`) | Prefer insert when feasible; else Copy + toast |
| Focus | App must be focused for gestures | Capture intended target at invocation |

The mock controller remains valid for browser tests and practice until BUS-13
wires a native adapter behind the same gesture contract
(`ShortcutGesture` / `ShortcutContext` in `src/services/contracts.ts`).

## Decision summary

1. **Register** the single configured shortcut on macOS via **Tauri
   `plugin-global-shortcut`** (Pressed + Released), with conflict detection and
   **revert to last-known-good** on failure.
2. **Hold / latch** keep provisional **320 ms / 260 ms** thresholds until a Mac
   dogfood pass retunes them; semantics must not collide with double-tap.
3. **Cancellation:** Escape only inside Voxloom UI, practice, or an **active
   capture session owned by Voxloom** — **recommend against** a global Escape
   hotkey.
4. **Target policy:** Snapshot the frontmost insertable target at **invocation**;
   at **completion**, insert there if still valid; otherwise Copy + truthful
   toast (aligns with the existing Copy sink).
5. **Clipboard:** Prefer insert; fall back to Copy; restore prior clipboard only
   when we successfully snapshotted it and no intervening user copy is detected —
   otherwise skip restore and say so.
6. **Insertion** never synthesizes Enter or command chords; suppress OS/IME
   popups that would fire from those keystrokes by not sending them.
7. **Windows** is a replaceable later adapter — not promised this sprint.

---

## 1. Native registration, conflicts, permissions (AC1)

### Recommended path (macOS)

**Primary:** Tauri 2 [`plugin-global-shortcut`](https://v2.tauri.app/plugin/global-shortcut/)
for the one user-configured combo.

- Use **Pressed** and **Released** events to drive the same hold / latch state
  machine that `shortcutController.ts` implements today (down starts hold timer /
  latch window; up finishes hold or records a tap).
- Why this over a full **CGEvent tap** for the shortcut itself:
  - Narrower privilege surface for “one global combo.”
  - Fits Tauri’s capability model and keeps product UI off raw Carbon/CG glue.
  - Conflict feedback is explicit: register fails when another app (or the OS)
    already owns the combo.

**Escalation (only if Pressed/Released prove insufficient for hold timing or
modifier edge cases on a Clara Mac trial):** a dedicated CGEvent tap / HID
monitor for that combo. That path typically needs **Accessibility** and may
prompt **Input Monitoring**. Do not start there for BUS-13 without a recorded
failure of the plugin path.

### Conflict detection and last-known-good

| Step | Behavior |
|------|----------|
| Persist | Settings already store `shortcut` durably (BUS-11). Also keep an in-memory / durable **`lastKnownGoodShortcut`** (initially equal to the last successfully registered value). |
| Apply | Unregister previous native binding → attempt register(new). |
| Success | Update `lastKnownGoodShortcut` = new; clear collision UI. |
| Failure | Re-register `lastKnownGoodShortcut` (best effort); keep Settings display honest (“could not bind … kept prior shortcut”); do **not** claim the new combo is active. |
| Boot | Register `lastKnownGoodShortcut` (or settings value if never failed). If boot register fails, surface a non-blocking toast and leave gestures unbound until the user picks a free combo — still retain the last known good string for retry. |

Hard-coded collision strings in the mock Settings UI are prototypes only.

### Permissions (honest)

| Permission | When needed | Notes |
|------------|-------------|-------|
| **Microphone** | Capture (already BUS-9/10) | Separate from shortcuts. |
| **Accessibility** | Text insertion into other apps (AX / synthetic typing alternatives); CGEvent-tap escalation | Not required solely to *try* `plugin-global-shortcut` registration. Required before promising insert. |
| **Input Monitoring** | Some global key monitors / taps | Call out in onboarding only if the escalated tap path is chosen. |
| Clipboard | Write (and read-for-restore) via existing clipboard plugin / APIs | Write already used by Copy sink. |

TCC **deny / revoke UX** is an explicit non-goal of BUS-12 (see Non-goals).

---

## 2. Hold / latch timings and cancellation (AC2)

### Timing principles

- **Hold:** Key must stay down past `holdMs` before `hold-start`. Release before
  the threshold counts as a tap candidate, not a hold.
- **Latch:** Two taps within `doubleTapMs` → `latch-start`; a later activation of
  the same shortcut → `latch-finish`. While latched, ignore the synthetic “up”
  that would otherwise look like a tap.
- **Collision avoidance:** One combo, one state machine — never arm hold and
  latch from the same down edge. The existing mock ordering (double-tap check
  before arming hold) is the native algorithm to port.
- **Provisional numbers:** Keep **`holdMs = 320`**, **`doubleTapMs = 260`** as
  native targets until a Mac dogfood pass measures accidental latch vs sluggish
  hold. Retune is a settings/constants change, not a new decision record, unless
  semantics change.

### Cancellation — Escape policy

| Scope | Escape behavior | Decision |
|-------|-----------------|----------|
| Voxloom dialogs / shortcut help / reset prompts | Closes UI (existing `Dialog`) | **Keep** |
| Onboarding / practice | UI-scoped dismiss / step rules only | **Keep scoped** |
| Active capture / listening session **while Voxloom owns the session** | Cancel capture / discard utterance via in-app or session-scoped handler (may be a Voxloom window keybinding or overlay control in BUS-13) | **Allowed** |
| **Global** Escape while another app is focused | Would steal Escape from every app | **Rejected** unless a future ADR explicitly revisits with strong UX evidence |

**Recommendation:** Do **not** register Escape as a `plugin-global-shortcut`.
Cancellation of an in-flight dictation from another app should use either
(a) releasing / finishing the dictation shortcut, (b) an in-overlay cancel
control (BUS-13), or (c) focusing Voxloom and using UI cancel — not a global
Escape grab.

---

## 3. Dialog / practice / context reset vs other-app focus (AC3)

`ShortcutContext` today: `"practice" | "product" | null`.

| Context | Meaning | Native implication |
|---------|---------|-------------------|
| `null` | Modal / shortcut dialog / non-practice onboarding — **reset** gesture state; do not start dictation | Same: suppress product gestures; clear hold/latch timers |
| `practice` | Onboarding step 3 practice — gestures update onboarding flags only | May remain **focused-window** even after native global product gestures exist (practice is inside Voxloom) |
| `product` | Normal dictation gestures | Native global shortcut drives dictation |

**Ordinary other-app focus** (user alt-tabs to Mail, etc.):

- Does **not** by itself cancel an in-flight hold/latch session.
- Does **not** change the **invocation-time intended target** (see §4).
- Does **not** imply Escape is globally available.
- Opening a Voxloom modal still forces context `null` and resets the state
  machine when Voxloom UI takes over.

Distinguish **context reset** (Voxloom UI / practice gates) from **target
validity** (whether the invocation-time app can still receive insert).

---

## 4. Invocation-time vs completion-time target policy (AC4)

### Policy

1. **Invocation time** (`hold-start` / `latch-start`): Snapshot **intended
   target** — frontmost app + focused AX element (or equivalent), including
   whether it looks insertable (text field vs secure field vs unknown).
2. **During capture:** User may change focus freely; we do **not** retarget
   mid-utterance by default (predictable “dictate into where I started”).
3. **Completion time** (transcript ready to deliver):
   - If intended target still exists, is focused-or-restorable, and is
     **insertable** → attempt insert.
   - If target **closed**, **replaced**, became a **secure field**, or is
     **unsupported** → **do not** insert; fall back to **Copy** + truthful toast
     (e.g. “Copied — original app closed” / “Copied — secure field”).
   - If insert API fails after a valid-looking target → Copy + toast naming the
     failure class when known.

### Secure / unsupported targets

- **Secure fields** (password, etc.): never insert; Copy fallback only if the
  user explicitly expects clipboard use — default toast should state that insert
  was skipped for a secure field.
- **Unsupported:** non-text controls, empty AX trees, apps that refuse
  accessibility — same Copy fallback, honest copy.

This aligns delivery with the existing **Copy sink** as the reliable floor
until BUS-14 hardens insert.

---

## 5. Clipboard fallback, restore, recovery (AC5)

| Rule | Decision |
|------|----------|
| Prefer | Insert into intended target when policy §4 allows |
| Else | Write transcript via clipboard (existing adapter / Copy sink) and toast |
| Snapshot | Before an insert path that temporarily uses paste, read prior clipboard **once** if the platform allows |
| Restore | Restore prior clipboard **only if** (a) snapshot succeeded, (b) our write/paste path completed, and (c) we have no evidence the user copied something else in between |
| If restore unsafe | **Skip restore**; toast that the transcript remains on the clipboard (or that prior clipboard could not be restored) |
| Manual recovery | History / Recent already retains transcripts (BUS-17); user can re-Copy from History — do not invent silent cloud sync |

Be truthful: never claim “inserted” when only Copy succeeded; never claim
“clipboard restored” when restore was skipped.

---

## 6. No Enter / commands; popup suppression (AC6)

- Insertion must deliver **text only** (AX `setValue` / selected-text replace,
  or paste of plain text). 
- **Never** synthesize **Enter**, **Tab**, or **modifier command chords**
  (⌘C/⌘V as a *product* “submit,” ⌘␣, etc.) as part of insertion.
- If a paste-based fallback is used, prefer clipboard plain-text write + a
  single paste action only when Accessibility paste is the documented insert
  method — still without trailing Enter.
- **Popup suppression criteria:** Avoid keystrokes that open Spotlight,
  emoji pickers, IME commit popups, or app command palettes. Prefer AX value
  set over key injection when both work. If only key injection works, inject
  Unicode/text events without virtual Enter/Return.

---

## 7. Windows replaceability (AC7)

- Define a thin **platform adapter** boundary in later implementation tickets
  (register / unregister / pressed-released stream; target snapshot; insert;
  clipboard). macOS is the first concrete adapter.
- **Windows** remains a **replaceable later adapter**. This ADR does **not**
  promise Win32 hotkeys, UI Access, or a ship date.
- Shared TypeScript gesture semantics (hold/latch/context) stay platform-agnostic.

---

## Non-goals (explicit)

| Item | Owner / deferral |
|------|------------------|
| Global overlay / waveform / always-on HUD | **BUS-13** |
| Insert polish beyond this strategy (retries, caret heuristics, rich paste) | **BUS-14** |
| TCC deny / revoke education flows | Later permissions UX |
| Implementing native registration in this PR | Out of scope — docs (+ optional ADR pointers) only |
| Claiming browser focused-window demos as native proof | Forbidden by ticket verification note |
| Cloud STT / silent downloads | Rejected (local-first) |

---

## Alternatives considered

| Alternative | Why not (for now) |
|-------------|-------------------|
| CGEvent tap as the default shortcut path | Heavier TCC; harder conflict messaging; keep as escalation |
| Global Escape to cancel | Steals Escape from every app; rejected in §2 |
| Always retarget to frontmost app at completion | Surprising inserts into the wrong window; rejected in favor of invocation snapshot |
| Always restore clipboard | Lies when snapshot fails or user copied mid-flight |
| Insert via Enter-terminated keystrokes | Violates AC6; triggers commands/popups |

## Consequences

- BUS-13 may add `plugin-global-shortcut`, capabilities, and a native bridge
  that emits the existing `ShortcutGesture` events — without redesigning hold /
  latch semantics.
- BUS-14 implements insert against the invocation-target policy and keeps Copy
  as the truthful fallback.
- Onboarding copy (ONB-03 / ONB-06) should eventually mention Accessibility
  when insert ships, and must not promise global Escape.
- Desktop shell ADR remains valid: shell can gain capabilities incrementally;
  product components still talk to adapters, not raw OS APIs.

## Related code (mock / contracts)

- `src/services/shortcutController.ts` — focused-window prototype timings
- `src/services/contracts.ts` — `ShortcutGesture`, `ShortcutContext`
- `src/app/useShortcutGestures.ts` — practice vs product gating
- `src/services/stt/copySink.ts` — Copy-before-insert floor
- `src/services/clipboard.ts` — clipboard write adapter
