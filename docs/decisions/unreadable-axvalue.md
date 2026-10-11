# Amendment: insert into text elements whose AXValue is unreadable

- **Status:** Proposed. **Flagged:** this relaxes a documented BUS-14 safety rule.
- **Date:** 2026-10-11
- **Context:** Apple Messages on the MacBook Air reports `Copied — insert failed: AXValue unreadable before insert — insert skipped`.
  - The gate is `decide/web.rs` `choose_insert_path` (reached via `decide/terminal.rs` `choose_path` from `macos/mod.rs` `insert_text`). It applies to **every** insertable target, not only web content.
  - Messages reaches it because its composer classifies as an insertable, non-secure text role (`AXTextArea`/`AXTextField`; otherwise the reason would be an unsupported role). However, its `AXValue` is not a readable CFString, so `copy_string_attr` returns `None`. The exact role and subrole still need checking with Accessibility Inspector on the Mac.
  - BUS-14 (`docs/review/BUS-14-insert-delivery.md`, "text-like roles require a readable AXValue before the write") added the rule after **false "Inserted" claims**.

## Decision
When `AXValue` is unreadable but the target is otherwise a validated, focused, insertable, **non-secure** text element:
- write `AXSelectedText` **once** (no retry, no typing, no `AXValue` write);
- verify using `AXNumberOfCharacters` before/after plus the selected text's length (UTF-16 units):
  - **exact expected count** → Inserted (detail "verified by character count");
  - **unchanged** → Failed → Copy/Failed policy;
  - **anything else or unknown** → **Unverified** ("May have been inserted — also copied").

The secure-field guard stays absolute. `AXSecureTextField` (role or subrole) and kind `secure` are refused before any write, independently of this path.

## Why this keeps the BUS-14 intent
The original harm was claiming Inserted without proof. Here, Inserted needs a count change exactly matching the transcript, and every ambiguous case is reported as Unverified with Copy. There's still only one write, so there's no double-insert risk. The residual risk: a count-matching but different mutation is reported as Inserted. That's unlikely for a single selected-text write, but Mac verification is required.
