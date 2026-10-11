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
   - **Window/page guard (review on #35):** at completion, capture the app's focused window (`AXFocusedWindow`), its `AXDocument`, and the focused web area's `AXURL`/`AXDocument` where available (`macos/web_ctx.rs`). On **every** poll and on the field that's found, the window must be the same element (CFEqual) and every identity known at completion must be unchanged; the found field's web area URL must match a URL captured at completion. Switching window, tab, or page during the wait aborts to Copy. Policy: `decide/web_ax.rs` `context_holds`. Limitation: moving to another field on the same page and in the same window within the wait isn't detectable, because no field existed to compare against.
3. **One guarded retry** (`decide/retry.rs`), on "AXSelectedText reported success but nothing changed" in an allowlisted host:
   - It runs only when the first write returned **Ok** and read back unchanged; never after an AX error.
   - Re-assert, then require **two unchanged reads** (after 150 ms, then 300 ms). If the late first write shows up on either read, report Inserted with no second write; any other change → Unverified with no write.
   - Otherwise write once more (after re-checking focus) and **poll** the read-back (30 × 20 ms).
   - The retry doesn't apply on the TypeFallback path: that's only taken when the field is provably web content, and it already has its own per-chunk verification. Kyle's Chrome error comes from the `Failed` branch, so it is covered: when the tree is dropped, the field has no DOM id and no AXWebArea ancestor, so `may_type` is false.
4. **Read-back normalization.** Both sides are compared after mapping U+00A0 → space and `\r\n`/`\r` → `\n`, and dropping U+FFFC. Nothing else is folded, so partial and transformed writes are still rejected.

## Why the #25 rule is relaxed
The rule existed so a background warm-up could not silently choose a field the user moved to later. The new wait is synchronous, bounded, and pinned to the app that was frontmost at completion. Within one app, the field Chromium reports once its tree is on is the field that had keyboard focus at completion; the tree simply wasn't exposed yet. Cross-app retargeting remains impossible. Secure-field, changed-target and identity checks are unchanged.

## AXEnhancedUserInterface side effects
- Chromium is re-sent `AXEnhancedUserInterface=true` on **every** insert attempt (frontmost allowlisted Chromium app only). That attribute is also how VoiceOver signals itself. Known side effect: while it's on, window-manager tools that resize via AX (Rectangle, Magnet, Moom) can animate badly or snap slowly in that app, and some window animations are slower.
- Electron gets `AXManualAccessibility`, which has no such side effect.
- **Setting `AXManualAccessibility` first on Chromium** (and only falling back to EnhancedUserInterface) isn't done here. `decide/host.rs` deliberately sends exactly one, upstream-sourced attribute per host and never probes alternates, and whether current Chrome honours `AXManualAccessibility` hasn't been verified on a Mac. Proposed follow-up: measure it with Accessibility Inspector, then switch if it works.

## Consequences
- Dictation into Chrome/Electron can take up to about 2.4 s longer when the tree was off.
- Setting `AXEnhancedUserInterface` on Chrome repeatedly is harmless, but it is known to slow window animations while on. This only happens for the frontmost allowlisted app at completion.
