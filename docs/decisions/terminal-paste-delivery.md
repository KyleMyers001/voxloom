# Terminal paste route

WezTerm, Alacritty, kitty, Ghostty and iTerm2 expose no AX text field that accepts writes, and posting Unicode key events to them is not reliable. They take a separate route: put the transcript on the clipboard, post one ⌘V, then put the user's clipboard back. Terminal.app keeps its guarded Unicode dispatch (see `apple-terminal-delivery.md`). Warp is not on this route: it only gets the Copy hint.

## Route

- Native flags the snapshot `pasteTerminal` from the frontmost process's executable bundle name (`decide/known_terminal.rs`). TS plans `paste` before it considers AX insertability, except for a secure, changed or closed target.
- `delivery_paste_text` re-resolves the frontmost app itself: same PID as the snapshot, still on the allowlist, Accessibility and event-posting permission granted, Secure Keyboard Entry off. Any failure is an `Err` and nothing was pasted; TS then copies with the terminal hint.
- The transcript must pass the same checks as Terminal dispatch (no control characters, newline or tab, at most 4096 UTF-16 units). A paste can run a command in a shell, so a transcript that could is refused and copied instead.
- ⌘V is posted as one flagged key press, using the keycode that types "v" in the current ASCII-capable layout (fallback: the ANSI V key). The layout lookup hops to the main thread.
- The sequence and the restore rules are in `decide/paste.rs`, tested with a fake host; `macos/pasteboard.rs` and `macos/paste.rs` are the OS glue.

## Clipboard restore

Before writing, every pasteboard item and type is copied out. The transcript is written with the `org.nspasteboard.TransientType` marker so clipboard managers skip it. After `CLIPBOARD_RESTORE_DELAY_MS` the saved items go back, but only if the pasteboard change count is still the one our write produced: a copy the user made meanwhile is never overwritten. If the old clipboard could not be saved in full, or the restore fails, the paste still stands and the report says the clipboard was not restored.

## Outcomes

A posted paste is recorded `unverified`: a terminal has no field to read back. The HUD treats it like any successful insert (silent); History keeps the badge. Fallbacks to Copy show "Copied. Press ⌘V to paste.".

## Known gaps

- A password prompt that does not turn on Secure Keyboard Entry (for example `sudo` in most terminals) cannot be detected, so a dictation could be pasted into it.
- A terminal that reads the pasteboard later than the restore delay would paste the user's previous clipboard instead.
