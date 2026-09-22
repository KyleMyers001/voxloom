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

## Residual risks

| Residual | Notes |
|----------|--------|
| macOS transparent overlay needs `macOSPrivateApi` | Enabled; Clara must confirm no focus steal on real fullscreen apps |
| In-memory last-known-good only | Boot retries Settings shortcut; durable LKG field deferred |
| Linux global-shortcut behavior | Compiles; product claim remains macOS-first |
| Practice path still focused-window | Intentional per ADR §3 |
| Insert / delivery | BUS-14 |
