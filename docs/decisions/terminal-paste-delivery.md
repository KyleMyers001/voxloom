# Terminal paste route

WezTerm, Alacritty, kitty, Ghostty and iTerm2 expose no AX text field that accepts writes, and posting Unicode key events to them is not reliable. They take a separate route: put the transcript on the clipboard, post one ⌘V, then put the user's clipboard back. Terminal.app keeps its guarded Unicode dispatch (see `apple-terminal-delivery.md`). Warp is not on this route: it only gets the Copy hint.

**Apple Messages** (`com.apple.MobileSMS`) takes the same route (BUS-34). Its composer gives no readable AXValue, so AX insertion was skipped and dictation fell back to Copy. It is matched by its exact system path (`/System/Applications/Messages.app/Contents/MacOS/Messages`, `decide/messages_app.rs`), not by bundle name. Binding, ⌘V, clipboard restore, silent success and Unverified History are identical. The `knownTerminal`, `pasteTerminal` and `pasteApp` snapshot fields keep their names (IPC contract) and now also cover Messages. Not verified on a Mac yet: real paste into Messages (empty composer, composer with text). Like the terminals, a paste lands wherever Messages has keyboard focus, which Voxloom cannot see.

## Route

- Native flags every snapshot `pasteTerminal`, with the terminal's app path (`pasteApp`) and pid (`appPid`, taken from the frontmost app when AX gave none), from the process's executable bundle name (`decide/known_terminal.rs`).
- **Binding.** When a dictation session starts (hold press, before any await), `delivery_paste_binding` records the pid and app path of the frontmost app if it is a paste terminal, and nothing otherwise. That value travels with the session and is read at delivery. It is never re-derived after transcription, so the terminal that was in front when you started dictating is the only one a paste can go to. Starting from the Voxloom window itself therefore never pastes.
- TS plans `paste` only when Clipboard fallback is on and that binding, the completion-time snapshot and the current snapshot all name the same terminal (same pid and app path), and the target is not secure, changed or closed. Otherwise nothing changes from before the route existed: Copy with the hint, or Failed when fallback is off. Notes at hold start then a terminal at delivery, or one terminal then another during transcription, both copy.
- `delivery_paste_text` receives the binding and re-resolves the frontmost app: same pid and app path as the terminal dictation started in, still on the allowlist (`decide/paste_target.rs`), Accessibility and event-posting permission granted, Secure Keyboard Entry off. A missing binding fails closed. Any failure is an `Err` and nothing was pasted; TS then copies with the terminal hint.
- **Silent success.** A clean paste has an empty message: no status line, no toast, no HUD result. History records it Unverified and native logs one line (never the text). Only a paste whose clipboard was not restored says so, in the warn tone: `Paste sent (clipboard not restored: <reason>)`. For screen readers a clean paste behaves like any result: the "Last transcript" live region updates; there is no status-line announcement.
- The transcript must pass the same checks as Terminal dispatch (no control characters, newline or tab, at most 4096 UTF-16 units). A paste can run a command in a shell, so a transcript that could is refused and copied instead.
- ⌘V is posted as one flagged key press, using the keycode that types "v" in the current ASCII-capable layout (fallback: the ANSI V key). The layout lookup hops to the main thread.
- The sequence and the restore rules are in `decide/paste.rs`, tested with a fake host; `macos/pasteboard.rs` and `macos/paste.rs` are the OS glue.

## Clipboard restore

Before writing, every pasteboard item and type is copied out. The transcript is written as a single pasteboard item carrying both the string and the `org.nspasteboard.TransientType` marker, in one call, so clipboard managers that honor the convention never see it unmarked. If the marker cannot be attached, the write fails before the pasteboard is touched: nothing is pasted, the prior clipboard is put back, and the transcript is copied with the terminal hint, as before the paste route. After `CLIPBOARD_RESTORE_DELAY_MS` the saved items go back, but only if the pasteboard change count is still the one our write produced: a copy the user made meanwhile is never overwritten. If the old clipboard could not be saved in full, or the restore fails, the paste still stands and the report says the clipboard was not restored.

## Outcomes

A posted paste is recorded `unverified`: a terminal has no field to read back. The HUD treats it like any successful insert (silent); History keeps the badge. Fallbacks to Copy show "Copied. Press ⌘V to paste.".

## Known gaps

- A password prompt that does not turn on Secure Keyboard Entry (for example `sudo` in most terminals) cannot be detected, so a dictation could be pasted into it.
- A terminal that reads the pasteboard later than the restore delay would paste the user's previous clipboard instead.
