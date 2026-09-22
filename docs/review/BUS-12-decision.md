# BUS-12 — Native shortcut, cancel, and focus strategy (decision)

Branch: `bus-12-shortcut-focus-strategy` (from `main` @ hydrate polish).

Jira: [BUS-12](https://kylemyers001.atlassian.net/browse/BUS-12) — **Task**
(status language at write time: To Do → ready for review as decision record;
implementation of native registration remains BUS-13).

**Primary ADR:** [`docs/decisions/native-shortcut-cancel-focus.md`](../decisions/native-shortcut-cancel-focus.md)

## What this slice is

A **macOS-first feasibility and decision record** for one global shortcut,
cancellation, target/focus, and clipboard strategy. It does **not** implement
global hotkeys, overlay, or insert (those are BUS-13 / BUS-14).

Focused-window browser behavior in `shortcutController.ts` stays a **mock** —
not native proof.

## AC → ADR map

| AC | Topic | ADR section |
|----|-------|-------------|
| 1 | Registration / conflict / permissions; last-known-good | §1 |
| 2 | Hold/latch + cancellation; no implied global Escape | §2 |
| 3 | Dialog/practice/context reset vs other-app focus | §3 |
| 4 | Invocation vs completion target; secure/unsupported | §4 |
| 5 | Clipboard fallback / restore / manual recovery | §5 |
| 6 | No Enter/commands; popup suppression | §6 |
| 7 | Windows as later adapter only | §7 |

## Decisions (short)

- **Register:** Tauri `plugin-global-shortcut` (Pressed/Released) first; CGEvent
  tap only if that path fails a Mac trial.
- **Timings:** Provisional native **320 ms** hold / **260 ms** double-tap
  (same as mock).
- **Escape:** UI / practice / active Voxloom-owned session only — **against**
  global Escape.
- **Target:** Snapshot at invocation; insert at completion if still valid;
  else Copy + truthful toast.
- **Clipboard:** Prefer insert; restore prior clipboard only when safe; else
  skip and say so.
- **Insert:** Text only — never Enter/command chords.
- **Windows:** Adapter later; not promised this sprint.

## Code touched

| Path | Change |
|------|--------|
| `docs/decisions/native-shortcut-cancel-focus.md` | ADR (primary) |
| `docs/review/BUS-12-decision.md` | This review / smoke doc |
| `src/services/shortcutController.ts` | Comment pointer: mock ≠ native ADR |
| `src/services/stt/copySink.ts` | Comment pointer to ADR delivery policy |

No native shortcut registration, capabilities, or OS automation in this PR.

## Emma review (decisions)

- [ ] ADR status and mock-vs-native boundary are clear
- [ ] Escape policy rejects global grab without a new ADR
- [ ] Invocation-time target + Copy fallback are consistent with Copy sink
- [ ] Clipboard restore rules are truthful (no silent “restored” lies)
- [ ] Non-goals correctly push overlay/insert polish to BUS-13/14
- [ ] Windows language does not promise a ship

## Clara Mac feasibility checklist

Mark ownership: **human Mac** vs **docs-only** (Linux CI / this box cannot
exercise TCC or global hotkeys).

| # | Item | Owner | Result |
|---|------|-------|--------|
| C1 | Register configured combo via intended Tauri global-shortcut path (Pressed + Released) | **Human Mac** (BUS-13 spike / trial) | Pending — docs prescribe path; not implemented here |
| C2 | Conflict: bind a combo already used by another app → register fails → UI keeps **last-known-good** | **Human Mac** | Pending — policy in ADR §1 |
| C3 | Permission deny: Accessibility denied → insert skipped, Copy + honest toast (no crash) | **Human Mac** (with BUS-14) | Pending — policy in ADR §4–5; deny UX non-goal |
| C4 | Last-known-good retention across failed Settings change and relaunch | **Human Mac** after native wire-up | Pending — algorithm in ADR §1 |
| C5 | Confirm mock 320/260 still feel usable under real global Pressed/Released | **Human Mac** dogfood | Pending — numbers provisional |
| C6 | Confirm Escape does **not** register globally; dialog Escape still works in-app | **Docs-only** now; **Human Mac** after BUS-13 | Docs assert reject; re-verify when native lands |
| C7 | Document blocked automation (no AX drive of System Settings from CI) | **Docs-only** | Covered in ADR verification bar + this table |

### Docs-only verification (this PR / CI)

```sh
npm run typecheck
```

Optional if TS comments change behavior (should be comments-only):

```sh
npm run lint
npm run test:unit
```

## Residual risks → later tickets

| Residual | Ticket |
|----------|--------|
| Actual `plugin-global-shortcut` wiring, capabilities, Pressed/Released → gesture bridge | **BUS-13** |
| Overlay / waveform / session cancel control while another app focused | **BUS-13** |
| AX insert implementation, caret/secure detection hardening | **BUS-14** |
| TCC deny/revoke education, Input Monitoring copy if tap escalation needed | Later permissions UX |
| Windows adapter | Unscheduled; interface only when needed |

## Jira status language (optional sync)

Suggested comment / transition when this PR merges: move BUS-12 toward
**Done** (decision delivered); leave BUS-13/14 open for implementation.
No Jira API write required from this PR.
