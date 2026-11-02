# Terminal paste route

WezTerm, Alacritty, kitty, Ghostty and iTerm2 expose no AX text field that accepts writes, and posting Unicode key events to them is not reliable. They take a separate route: put the transcript on the clipboard, post one ⌘V, then put the user's clipboard back. Terminal.app keeps its guarded Unicode dispatch (see `apple-terminal-delivery.md`). Warp is not on this route: it only gets the Copy hint.

## Route

- Native flags every snapshot `pasteTerminal`, with the terminal's app path (`pasteApp`) and pid (`appPid`, taken from the frontmost app when AX gave none), from the process's executable bundle name (`decide/known_terminal.rs`).
- TS plans `paste` only when Clipboard fallback is on and the snapshot from recording start and the current one are both paste terminals with the same pid and app path (and neither is a secure, changed or closed target). Otherwise nothing changes from before the route existed: Copy with the hint, or Failed when fallback is off.
- `delivery_paste_text` receives the recording-start snapshot and re-resolves the frontmost app: same pid and app path, still on the allowlist, Accessibility and event-posting permission granted, Secure Keyboard Entry off (`decide/paste_target.rs`). A missing pid or app path fails closed. Any failure is an `Err` and nothing was pasted; TS then copies with the terminal hint.
- The transcript must pass the same checks as Terminal dispatch (no control characters, newline or tab, at most 4096 UTF-16 units). A paste can run a command in a shell, so a transcript that could is refused and copied instead.
- ⌘V is posted as one flagged key press, using the keycode that types "v" in the current ASCII-capable layout (fallback: the ANSI V key). The layout lookup hops to the main thread.
- The sequence and the restore rules are in `decide/paste.rs`, tested with a fake host; `macos/pasteboard.rs` and `macos/paste.rs` are the OS glue.

## Clipboard restore

Before writing, every pasteboard item and type is copied out. The transcript is written as a single pasteboard item carrying both the string and the `org.nspasteboard.TransientType` marker, in one call, so clipboard managers that honor the convention never see it unmarked. After `CLIPBOARD_RESTORE_DELAY_MS` the saved items go back, but only if the pasteboard change count is still the one our write produced: a copy the user made meanwhile is never overwritten. If the old clipboard could not be saved in full, or the restore fails, the paste still stands and the report says the clipboard was not restored.

## Outcomes

A posted paste is recorded `unverified`: a terminal has no field to read back. The HUD treats it like any successful insert (silent); History keeps the badge. Fallbacks to Copy show "Copied. Press ⌘V to paste.".

## Known gaps

- A password prompt that does not turn on Secure Keyboard Entry (for example `sudo` in most terminals) cannot be detected, so a dictation could be pasted into it.
- A terminal that reads the pasteboard later than the restore delay would paste the user's previous clipboard instead.
