# Amendment: re-enable web accessibility on every insert; allow a same-app late target

- **Status:** Proposed (amends the BUS-14 / #25 completion-target rule)
- **Date:** 2026-10-11
- **Context:** On Kyle's MacBook Air, Chrome page fields reported `Copied — insert failed: AXSelectedText reported success but nothing changed`. The Chrome address bar (native AppKit) and Notes worked, and **restarting Chrome fixed it** until it broke again. The Mac mini worked with the same build and permissions.
  - #25 enabled Chromium's `AXEnhancedUserInterface` / Electron's `AXManualAccessibility` **once per pid** (cached) and only in a background warm-up. If the app later drops its web accessibility tree while idle, we never re-enable it.
  - The completion target was always the first, pre-warm-up observation, so the first dictation after a cold or dropped tree always fell back to Copy.
  - Another AX client on the mini (password manager, Grammarly, Raycast, Rectangle, Accessibility Inspector, VoiceOver…) can keep Chromium's tree on, which masked the bug there.

## Decision
1. **No per-pid cache.** At every completion snapshot (each insert attempt), set the host's activation attribute again. It's idempotent and limited to the existing strict Chromium/Electron allowlist (`decide/host.rs`).
2. **Same-app late target (reverses #25's "no later-discovered field" rule, in a narrow form).** If the first completion read is only a web container (or no focus) in an allowlisted host, wait synchronously for at most about 2.4 s (61 × 40 ms; Chromium/Electron debounce activation for 2 s). A field found during the wait is used **only if**:
   - the same pid stays frontmost on every read, and
   - the focused element belongs to that pid.

   Any app switch aborts the wait and keeps the original non-insertable observation (Copy).
   - The snapshot command is now async so this wait never blocks the UI thread.
3. **One guarded retry.** On "AXSelectedText reported success but nothing changed" in an allowlisted host: re-assert, settle 150 ms, and **re-read** the field.
   - If the first write landed late, report Inserted without writing again.
   - If the field is still exactly as before, re-check focus and write once more.
   - If the field changed in any other way, report Unverified. Never write twice.
4. **Read-back normalization.** Both sides are compared after mapping U+00A0 → space and `\r\n`/`\r` → `\n`, and dropping U+FFFC. Nothing else is folded, so partial and transformed writes are still rejected.

## Why the #25 rule is relaxed
The rule existed so a background warm-up could not silently choose a field the user moved to later. The new wait is synchronous, bounded, and pinned to the app that was frontmost at completion. Within one app, the field Chromium reports once its tree is on is the field that had keyboard focus at completion; the tree simply wasn't exposed yet. Cross-app retargeting remains impossible. Secure-field, changed-target and identity checks are unchanged.

## Consequences
- Dictation into Chrome/Electron can take up to about 2.4 s longer when the tree was off.
- Setting `AXEnhancedUserInterface` on Chrome repeatedly is harmless, but it is known to slow window animations while on. This only happens for the frontmost allowlisted app at completion.
