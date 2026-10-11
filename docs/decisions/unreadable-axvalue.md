# Amendment: Apple Messages insert with unreadable AXValue

- **Status:** Proposed. **Pending Kyle's sign-off.** Flagged: this relaxes a documented BUS-14 safety rule, for **Messages only**.
- **Date:** 2026-10-11
- **Scope:** bundle id `com.apple.MobileSMS` only (`decide/messages.rs` `unreadable_value_allowed`). Every other app whose AXValue is unreadable is still refused with `AXValue unreadable before insert — insert skipped` (BUS-14 rule unchanged).

## Context
- Messages on the MacBook Air: `Copied — insert failed: AXValue unreadable before insert — insert skipped`. The gate is `decide/web.rs` `choose_insert_path` (from `decide/terminal.rs` `choose_path`, called in `macos/mod.rs` `insert_text`). The composer already passed the role and secure checks, so it's a non-secure text role; its AXValue just isn't a readable string.
- After the first version of this change (#35 at 5dbe087): `Copied — insert failed: AXSelectedText reported success but nothing changed`. That string comes from `decide/length.rs` `after_ax_by_length`: both `AXNumberOfCharacters` reads succeeded and were equal after an `AXSelectedText` set that returned Ok. In other words, the composer ignores AXSelectedText while reporting success.
- BUS-14 (`docs/review/BUS-14-insert-delivery.md`, "text-like roles require a readable AXValue before the write") came from false "Inserted" claims.

## Decision (Messages only)
1. **Secure fields are refused first, unconditionally.** That covers kind `secure` and role/subrole `AXSecureTextField`.
2. **One AXSelectedText write.** Poll `AXNumberOfCharacters` for about 600 ms (30 × 20 ms):
   - exact expected delta (UTF-16, minus the selected length) → **Inserted**;
   - any other change → **Unverified** ("May have been inserted — also copied");
   - counts unreadable after an Ok write → **Unverified**, never Failed.
3. **Typing fallback**, used only when the write returned **Ok** and the count stayed unchanged:
   - First take two more spaced reads (150 ms, then 300 ms). If either shows a change, the late AX write landed, so we don't type: exact delta → Inserted, otherwise Unverified.
   - Otherwise use the existing guarded Unicode typing path (`macos/typing.rs` `type_text`): focus is re-checked before each chunk, and each chunk is confirmed by the count delta (polled about 600 ms).
   - A mismatch stops typing: nothing posted → Failed/Copy; partly posted → Unverified.
4. **Never after an AX error.** An AX error is Failed → Copy, with no typing.

## Residual risks
- A count-matching but different mutation is reported as Inserted.
- If the selection is unreadable, typing assumes a caret; a real selection then fails the first chunk's check and is reported honestly.
- If Messages applied the AX write more than about 1 s late, typing could double the text. The spaced reads make this unlikely; check it on the Mac.
