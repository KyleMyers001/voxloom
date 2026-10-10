# Guarded Apple Terminal dispatch

Apple Terminal is a dedicated Unicode-event delivery route, not an addition to the Chromium/Electron fallback allowlist. Native and browser insertion retain their existing AXSelectedText/read-back policy. Completion-time targeting remains unchanged.

## Evidence and limits

The prior trusted, in-process production `typing::type_text` probe sent exactly `Voxloom ASCII abc XYZ 123 café 日本語 🙂 fin` to an isolated non-interpreting byte-capture helper: 50 UTF-8 bytes, three chunks, no duplicates or substituted carrier characters. This establishes transport for that experiment, NOT AX read-back, CLI/TUI input-buffer semantics, or universal terminal compatibility. The private experiment evidence is archived outside the repository; no product source or build depends on it.

The product path shares the unchanged low-level Unicode event posting and UTF-16 chunking. It deliberately does not pretend that Terminal's AXValue (display/scrollback) proves the active input buffer. Unlike the probe, production has no raw-byte oracle. Its 20 ms pacing is not verification.

## Guarded route

- Host executable must exactly equal `/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal`.
- Only validated AXTextArea targets qualify; generic containers, secure roles and other Terminal controls refuse.
- The completion snapshot is retained natively. Validation and each chunk require the same CFEqual-backed element identity, PID, insertability and trust. The text area's AXWindow must be an AXWindow in that PID.
- Each chunk checks posting permission, accessibility trust, system-host path and independently observed frontmost PID. It never activates an app or changes focus. A focus-check/post race remains unavoidable for global CGEvents; the checks are not atomic destination binding.
- Validate the entire transcript before any Terminal mutation. Reject C0, C1, DEL, newline, carriage return, tab, Escape and Unicode line/paragraph separators. Never sanitize silently. Refuse empty payloads and payloads exceeding 4096 UTF-16 units.
- Direct Unicode dispatch only: no preliminary AX write, no clipboard transport, no paste chord, no synthesized Enter. Stop after the first error, target mismatch or five-second dispatch deadline (checked between chunks; this cannot interrupt a blocking OS call). Never retry any posted text.

## Honest outcomes

Native IPC adds optional `terminalDispatch: "complete" | "partial"`, always with `typed: true` and `unverified: true`. Complete means all event chunks were posted, not that input was accepted. Partial means at least one chunk was posted before dispatch stopped.

Both produce delivery/history status `unverified`, with “Text sent/partly sent to Terminal — input not verified. Inspect before retrying.” Neither automatically copies or retries, including cancellation after dispatch. History retains the transcript for explicit user Copy and shows the uncertainty. Zero-event refusal keeps the existing user-configured Copy/Failed policy. Existing native/web uncertain writes retain their prior policy.

## Security boundary and live acceptance

Printable characters can act as commands in terminal modes, editors and TUIs. Omitting Enter does NOT guarantee that no action or execution can occur. This is not a sandbox or a command-execution prevention mechanism. Use only a knowingly appropriate text prompt; inspect the destination before retrying or manually pasting.

User-reported live checks on the prior instrumented bundle include text appearing once without submission in an Apple Terminal CLI prompt, plus Hermes and TextEdit insertion; Chrome focus was addressed by host-specific AX bootstrap. These are scoped observations, not proof of every prompt, Unicode case or safety guard.

Build/unit tests do not establish current app permissions or real prompt behavior. The cleaned bundle still needs live regression checks after an explicitly approved installation. Remaining acceptance includes separate ASCII/Unicode cases, repeated utterances without duplicates, clipboard preservation, changed-target and secure-field refusal, and browser/Hermes/TextEdit checks. No CLI input is sent by the cleanup/build task.

Build the packaged artifact with `--locked --features whisper`. Temporary focus logging, transport-probe source, build feature, startup argument handling and arm watcher have been removed. Product source and executable must not contain developer-home paths or depend on private experiment files. User-facing AX error reasons and the production bootstrap/transport guards remain.
