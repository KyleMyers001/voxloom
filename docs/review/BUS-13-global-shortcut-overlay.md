# BUS-13 — Global shortcut + desktop waveform overlay

Branch: `bus-13-global-shortcut-overlay` (from `origin/main` + BUS-12 ADR).

Jira: [BUS-13](https://kylemyers001.atlassian.net/browse/BUS-13)

**ADR:** [`docs/decisions/native-shortcut-cancel-focus.md`](../decisions/native-shortcut-cancel-focus.md) (BUS-12)

## What this slice is

First **implementation** of macOS-first global hold / double-tap dictation via
Tauri `plugin-global-shortcut`, plus a non-focus-stealing desktop waveform
overlay. Delivery / insert remains out of scope (BUS-14).

Browser / Vite keeps the **document mock** adapter for unit tests — that path
does **not** prove native OS-wide registration.

## AC map

| AC | Implementation |
|----|----------------|
| 1. Shortcut works while another app focused; unregister/re-register | `nativeRegistration.ts` + `registerOrRevert.ts` + `tauri-plugin-global-shortcut`; capabilities on `main` |
| 2. Hold 320 ms / double-tap 260 ms | `gestureMachine.ts` constants (`HOLD_MS` / `DOUBLE_TAP_MS`) driven by Pressed/Released |
| 3. Partial gesture reset (dialogs, setup, suspend/resume, context) | `setContext` / `resetPartial`; visibilitychange + pagehide; modal/`ShortcutContext` null |
| 4. Overlay: bottom-center, 24 segments, listening/processing only, reduced-motion, no focus steal | `overlay.rs` + `overlayBridge.ts` + `overlay.html` (`focusable: false`, `focused: false`) |
| 5. Multi-display/fullscreen must not redirect delivery | Overlay only — no insert/delivery; positions on current/primary monitor |
| 6. Busy/cancel/error prevent concurrent capture / stale completion | Dictation machine + gesture start ignored while listening/processing; cancel/error clears overlay + partials |
| 7. Permission/conflict failures truthful + recoverable | Register-or-revert → last-known-good; Settings/toast message; no silent “active” claim |

## Non-goals (honored)

- Insertion into other apps / BUS-14 polish
- Overlay buttons, text labels, timers, placement settings
- Global Escape grab
- TCC deny/revoke UX beyond honest failure toasts
- Windows native adapter (plugin may load; not claimed)

## Emma review bar

- [ ] Gesture machine is Pressed/Released-driven; document mock still works for tests
- [ ] last-known-good / register-or-revert never claims a failed combo is active
- [ ] Overlay never focuses; visible only listening/processing; reduced-motion CSS
- [ ] No delivery/insert claims; no global Escape
- [ ] Unit tests cover machine + register-or-revert + overlay visibility (not native proof)
- [ ] Linux `cargo check` / typecheck / lint / unit green

## Clara Mac checklist (maps BUS-12 C1–C5)

| # | Item | Owner | Result |
|---|------|-------|--------|
| C1 | Register configured combo via Tauri global-shortcut (Pressed + Released) while **another app** is focused | **Human Mac** | Pending |
| C2 | Conflict: bind a combo already used → register fails → UI keeps **last-known-good** + honest toast | **Human Mac** | Pending |
| C3 | (From BUS-12) Accessibility deny → insert skipped — **out of scope** here; confirm shortcut still fails honestly without crash | **Human Mac** / docs | Shortcut path only this ticket |
| C4 | Last-known-good across failed Settings change and relaunch (in-memory this slice; settings value re-tried on boot) | **Human Mac** | Pending |
| C5 | Confirm 320/260 feel usable under real global Pressed/Released | **Human Mac** dogfood | Pending |
| C6 | Overlay bottom-center, 24 bars, no focus steal; hide on cancel/error/success | **Human Mac** | Pending |
| C7 | Fullscreen / multi-display (if available): overlay shows without redirecting delivery (delivery N/A) | **Human Mac** | Pending |
| C8 | `prefers-reduced-motion`: waveform not aggressively animated | **Human Mac** | Pending |
| C9 | Escape is **not** registered globally; in-app dialog Escape still works | **Human Mac** | Pending |

### Linux / CI verification (this PR)

```sh
npm run typecheck
npm run lint
npm run test:unit
cd src-tauri && cargo check
```

Do **not** treat browser unit tests as proof of native global registration.

## Key files

| Path | Role |
|------|------|
| `src/services/shortcut/gestureMachine.ts` | Pure hold/latch machine |
| `src/services/shortcut/registerOrRevert.ts` | last-known-good algorithm |
| `src/services/shortcut/nativeRegistration.ts` | Tauri plugin bridge |
| `src/services/shortcut/documentAdapter.ts` | Vite/test DOM adapter |
| `src/services/shortcut/overlayBridge.ts` | Show/hide + waveform sync |
| `src-tauri/src/overlay.rs` | Non-focusable overlay window |
| `overlay.html` / `src/overlay/*` | Overlay UI (waveform only) |
| `src/app/useShortcutGestures.ts` | Native vs document wiring |


## Mac hold-release failure mode (Clara) — fixed this slice

**Failure:** On Clara Mac, `Ctrl+Shift+F` / `Ctrl+Shift+Space` starts hold
dictation/overlay, but releasing keys never stops it. Carbon
`RegisterEventHotKey` registers `kEventHotKeyReleased`, yet macOS often never
delivers Released when modifiers lift first (same class of missing-release bug
`global-hotkey` addressed on Linux). Secondary: a Released that *does* arrive
can race before React commits `dictation.kind === "listening"`, so
`hold-finish` is dropped and the overlay/session sticks.

**Fix (BUS-12 ADR escalation, minimal):**

1. While hold is active (`hold-start`), arm a macOS-only hold-release watch
   (`src-tauri/src/hold_release.rs`): listen-only CGEvent tap for key-up +
   flagsChanged on the bound chord, with CGEvent session-state poll fallback
   when the tap cannot be created. Chord break emits `shortcut:hold-release`
   → gesture machine `released` → `hold-finish`. Tear-down on hold-finish,
   latch paths, cancel/error/`resetPartial`/dispose. **No global Escape.**
2. `createPendingFinishGate` — if finish arrives before listening commits, keep
   a pending flag and flush once listening lands.
3. Busy/cancel/error paths still clear overlay + partial gestures (+ pending).

Non-macOS builds expose no-op `hold_release_arm` / `hold_release_disarm` so
Linux `cargo check` stays green. Insertion remains BUS-14.

### Clara re-smoke (hold-release) — do this first

1. Build/run the PR branch on Mac (packaged or `tauri dev` with entitlements).
2. Focus **another app** (e.g. TextEdit / Notes).
3. Hold `Ctrl+Shift+Space` (or current Settings combo) past ~320 ms → overlay
   appears / listening starts.
4. **Release modifiers first**, then the key (and also key-first) → overlay
   must hide and dictation must finish (no stuck listening/processing).
5. Repeat with a short tap (no hold) and a double-tap latch; confirm latch still
   finishes on the next activation and Escape is **not** stolen globally.
6. While listening, open a Voxloom modal / cancel path → overlay + partials
   clear; no zombie hold watch.

| # | Item | Owner | Result |
|---|------|-------|--------|
| C10 | Hold-release: modifiers-first and key-first both stop overlay/session | **Human Mac** | Pending re-smoke |
| C11 | Pending-finish race: quick release after hold threshold still finishes | **Human Mac** | Pending re-smoke |

## Boot double-setShortcut race (Clara) — fixed this slice

**Failure:** On Clara Mac boot (`19d00cc`), mount + Settings-shortcut effects both
called `setShortcut` for the same combo in parallel. The second
`RegisterEventHotKey` failed (`RegisterEventHotKey failed for KeyF` / already
registered). That path toasted “Could not bind…”, bumped `generation` (so the
first callback was ignored), and could null `active` — after which global hold
did nothing. Seen with `Ctrl+Shift+F` and Space.

**Fix:**

1. `createNativeShortcutController.setShortcut` **serializes** registrations and
   **no-ops** when `active === next` (same combo already ours / just bound by a
   queued call) — no unregister/re-register, no generation bump, no false toast.
2. `useShortcutGestures` mount effect owns the **initial** bind; the Settings
   effect only rebinds when the shortcut **changes**.
3. True conflicts on a **different** combo still register-or-revert to
   last-known-good and toast honestly (unit-covered).

Hold-release / pending-finish from the prior Mac fix are unchanged.

### Clara re-smoke (boot bind) — do this first

1. Cold-start the PR build once on Mac (packaged or `tauri dev`).
2. Confirm **no** false “Could not bind…” toast on a free Settings combo.
3. Focus another app; hold the configured shortcut past ~320 ms → overlay /
   listening starts; release (modifiers-first and key-first) still finishes
   (C10/C11).
4. Optionally change Settings to a free combo then back — rebind works; change
   to an OS-conflicted combo → honest toast + prior combo kept.

| # | Item | Owner | Result |
|---|------|-------|--------|
| C12 | Boot: single bind, no false conflict toast; hold still works | **Human Mac** | Pending re-smoke |

## Residual risks

| Residual | Notes |
|----------|--------|
| macOS transparent overlay needs `macOSPrivateApi` | Enabled; Clara must confirm no focus steal on real fullscreen apps |
| In-memory last-known-good only | Boot retries Settings shortcut; durable LKG field deferred |
| Linux global-shortcut behavior | Compiles; product claim remains macOS-first |
| Practice path still focused-window | Intentional per ADR §3 |
| Insert / delivery | BUS-14 |
| Mac HotKey Released drop | Mitigated: NSEvent + CGEvent hold-release watch while hold active; Clara C10/C11 |
| Hold-finish vs listening race | Mitigated: pending-finish gate |
| Boot double-setShortcut race | Mitigated: serialize + same-combo no-op; Settings effect skips initial bind (C12) |
| CGEvent tap may need Accessibility | Session-state poll fallback covers other-app focus without AX; tap is hold-scoped only |
