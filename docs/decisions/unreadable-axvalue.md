# Amendment: Apple Messages guarded insert (unreadable or readable AXValue)

- **Status:** Proposed. **Pending Kyle's sign-off.** Flagged: this relaxes a documented BUS-14 safety rule, for **Messages only**.
- **Date:** 2026-10-11
- **Scope:** bundle id `com.apple.MobileSMS` only (`decide/messages.rs` `unreadable_value_allowed`). Every other app whose AXValue is unreadable is still refused, and other apps with a readable value keep the normal path with `AXValue unreadable before insert — insert skipped` (BUS-14 rule unchanged).

## Context
- Messages on the MacBook Air: `Copied — insert failed: AXValue unreadable before insert — insert skipped`. The gate is `decide/web.rs` `choose_insert_path` (from `decide/terminal.rs` `choose_path`, called in `macos/mod.rs` `insert_text`). The composer already passed the role and secure checks, so it's a non-secure text role; its AXValue just isn't a readable string.
- After the first version of this change (#35 at 5dbe087): `Copied — insert failed: AXSelectedText reported success but nothing changed`. That string comes from `decide/length.rs` `after_ax_by_length`: both `AXNumberOfCharacters` reads succeeded and were equal after an `AXSelectedText` set that returned Ok. In other words, the composer ignores AXSelectedText while reporting success.
- BUS-14 (`docs/review/BUS-14-insert-delivery.md`, "text-like roles require a readable AXValue before the write") came from false "Inserted" claims.

- Second-attempt report (af29016): `Copied — insert failed: AXSelectedText reported success but nothing changed`. After the first insert the composer holds text and its AXValue becomes **readable**, so `choose_insert_path` sent it down the plain readable path (`macos/ax_insert.rs`). Messages isn't a web field or a Unicode-typing host, so `may_type` was false, and it isn't a Chromium/Electron host, so there was no retry. `after_ax` returned that Failed string, and the Messages typing fallback (unreadable branch only) never ran.

## Decision (Messages only)
0. Messages **always** takes the guarded flow below, whether AXValue is readable or not (`InsertPath::MessagesGuarded`). When AXValue is readable:
   - the count falls back to its UTF-16 length if `AXNumberOfCharacters` is missing;
   - any success (AX or typed) is cross-checked against the value: if the value doesn't prove the insert → Unverified.
1. **Secure fields are refused first, unconditionally.** That covers kind `secure` and role/subrole `AXSecureTextField`.
2. **One AXSelectedText write.** Poll `AXNumberOfCharacters` for about 600 ms (30 × 20 ms):
   - exact expected delta (UTF-16, minus the selected length) → **Inserted**;
   - any other change → **Unverified** ("May have been inserted — also copied");
   - counts unreadable after an Ok write → **Unverified**, never Failed.
3. **Typing fallback**, used only when the write returned **Ok** and the count stayed unchanged:
   - First take two more spaced reads (150 ms, then 300 ms). If either shows a change, the late AX write landed, so we don't type: exact delta → Inserted, otherwise Unverified.
   - Otherwise use the existing guarded Unicode typing path (`macos/typing.rs` `type_text`): focus is re-checked before each chunk, and each chunk is confirmed by the count delta (polled about 600 ms).
   - One more count read **right before the first typed chunk**. If it moved, the late AX write landed, so we don't type: exact delta → Inserted, otherwise Unverified.
   - A mismatch stops typing: nothing posted → Failed/Copy; partly posted → Unverified.
   - About 300 ms after typing completes, the count is read again. If it isn't exactly the expected total (for example a late AX write overshot it) → **Unverified** ("May have been inserted — also copied").
4. **Never after an AX error.** An AX error is Failed → Copy, with no typing.

## Residual risks
- A count-matching but different mutation is reported as Inserted.
- If the selection is unreadable, typing assumes a caret; a real selection then fails the first chunk's check and is reported honestly.
- If Messages applied the AX write more than about 1 s late, typing could double the text. The spaced reads make this unlikely; check it on the Mac.
- If a selection of the same length as the transcript is replaced, the count is unchanged by design. That's ambiguous, so no typing happens and the result is Unverified ("May have been inserted — also copied").
