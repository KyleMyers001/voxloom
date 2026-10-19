# BUS-43: Escape while the dictation popup is active

## Decision

Escape cancels **listening and transcription**, including a pending microphone start once the popup is visible. Cancelled dictations do **not** appear in History. They do not insert text, write the clipboard, or surface a late transcription error/result. A new dictation can start normally afterward.

This supersedes the global-Escape rejection in the original BUS-12 ADR only for the visible, session-owned dictation popup. There is no permanent Escape shortcut. Result banners (Copied/failure), idle Voxloom, and a hidden popup do not own Escape. A newly armed scope always starts hidden, even if a result banner is still on screen; only the cancellable popup show marks it visible.

## Implementation boundaries

- macOS uses an active session event tap on the main run loop. It passes every event except Escape key-down while its session's popup is visible. It does not activate/focus any app or synthesize keys. After cancellation, subsequent key events pass through.
- The tap latches native cancellation before cancelling capture and notifying the main renderer with an opaque session identifier. It hides the popup immediately. The callback does not free its own tap/context.
- After transcription resolves, the renderer must claim a native delivery barrier. This checks cancellation, closes the popup, and removes the tap on the same run loop. A cancelled or superseded scope cannot claim delivery even when its cancellation notification is delayed.
- The popup closes **before target lookup/delivery begins**. After this commit boundary, already-dispatched delivery cannot be recalled and Escape belongs to the foreground app again. Existing exact-target, secure-field, focus, Unicode-chunk and no-Enter safeguards remain unchanged.
- Closing/discarding an old scope uses its exact session ID; it cannot remove a newer scope. Stale cancellable popup-show requests are rejected when no live scope exists. Result popups explicitly opt out of cancellation.
- The frontend retains per-session cancellation separately from supersession. Explicit cancellation drops late history/toasts, while superseded (not cancelled) transcripts preserve the existing failed-history evidence policy.
- Existing model validation is still mandatory; there are no silent model downloads. Whisper work already running may finish in the background; its result is discarded on cancellation. This change does not add a Whisper interrupt API.

## Permissions and failure policy

An active macOS event tap needs the OS permission that permits event interception. The code never prompts, grants or resets permissions. If arming fails (the tap cannot be created or the process is not Accessibility-trusted), a warning is logged, Voxloom shows a one-time non-blocking "Escape-cancel is off" hint per app run (with Copy error details on Home, keyed on the native error code), and dictation still records and delivers, so Copy-only users without Accessibility permission keep working. The cancellable popup is not shown for that session; in-window Escape still cancels, and the next session re-arms fresh. A disabled/revoked tap cancels its scope fail-closed; it is not silently re-enabled.

The active tap can swallow Escape, which macOS gates on Accessibility, so only Accessibility trust picks the error code: `cancel-ax-untrusted` (not trusted) or `cancel-tap-create-failed` (trusted, yet the tap failed). The Input Monitoring and posting preflights (`listen=`, `post=`) are copied in the details as evidence only and never blame a grant. `cancel-arm-failed` covers non-tap arm errors. The Home note shows the latest failure and clears after a successful arm. For `cancel-ax-untrusted` it says to quit and reopen Voxloom after allowing it and offers **Open System Settings**, which opens only Privacy & Security → Accessibility through an allowlisted native command; it never requests or changes a permission. Each arm attempt writes one stderr line, `[cancel] arm ok` or `[cancel] arm failed code=<code>`; it is visible only when the binary is run from a terminal and is lost on a Finder launch.

The document Escape handler supports the focused-window/browser path, but is not evidence of cross-app interception. Native acceptance must be performed with the exact packaged app after user-approved permissions.

## Review and acceptance

Automated coverage checks cancellation during startup, cancellation vs late STT resolution/rejection, the native delivery barrier, listener cleanup, teardown errors, popup persistence during STT, result-banner pass-through, native Escape/disabled-tap policy and existing delivery regressions. Source-wiring checks are supplementary, not native integration proof.

Still required before approval/install: Escape in another app while listening and transcribing; idle/result Escape reaching the foreground app; denied/revoked interception permission; repeat hold/latch after cancellation; no clipboard/history changes; and ordinary native/browser insertion without cancellation. No live TCC or cross-app event delivery was exercised by this build-only implementation.

## Build prerequisite fix

The fetched base's macOS release library tests failed with duplicate `_EMBED_INFO_PLIST`: both the application entry and ACL test expanded `generate_context!()`. The application and mock-runtime ACL test now call one generic `app_context()` function, leaving only one macro expansion. The original failure was reproduced in a pristine source archive before applying the fix. It changes no ACL policy or app configuration.
