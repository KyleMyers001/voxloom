# Guided setup (BUS-208)

The approved B/v3 setup keeps a left progress spine: Welcome → Get connected →
Your shortcut → First words → Ready. First words contains two progressive tries,
not a permanent mode selection. The same writable note and accepted shortcut
serve hold/speak/release, then double-tap/speak/press-once-to-finish.

## Permission and model authority

- Microphone uses the existing AVFoundation bridge. Only microphone can report
  `not-determined`, `denied` and `restricted` distinctly. Accessibility and Input
  Monitoring boolean preflights report `not-granted` when false, never an invented
  denied/not-yet-requested distinction. Non-Mac adapters return unsupported.
- Querying, rechecking, returning to the window and model polling never request
  permissions. Allow is explicit. The first Accessibility request in a launch
  asks macOS to prompt (`AXIsProcessTrustedWithOptions` with the prompt option),
  which lists Voxloom in Privacy & Security › Accessibility and offers the
  system's own Open System Settings button, so Voxloom does not also open the
  pane as a second handoff. macOS may not repeat that alert, so later requests in
  the same launch open the Accessibility pane. Microphone requests only if not
  determined and otherwise hands off; Input Monitoring has an explicit request
  and separate Settings action.
- The new-user recommendation is **Whisper Base English**, `whisper-base.en`,
  **147,964,211 bytes** (148 MB). Its native revision, URL, hash and size pin are
  unchanged. No RAM, latency or quality benchmark motivated or accompanies this
  product decision. Existing explicit IDs and installed models are not migrated,
  deleted or automatically replaced. Larger models remain optional in Settings.
- Start setup discloses the selected pack and explicitly starts its download if
  missing. It never downloads on launch, reopening setup or ordinary rechecks.
  Interrupted transfers restart on Retry; no partial file is promoted to ready.
  Resuming a running native transfer observes status rather than starting another.
- Setup readiness is stricter than ordinary dictation's existing background hash
  allowance: the model store's pinned verification must finish, its current file
  fingerprint must still match, the compiled engine/platform must support it,
  and the native worker must exist for Parakeet. Loading/inference can still fail;
  only actual successful practice can complete the tutorial. No test downloads
  weights to manufacture acceptance.

## Dictation ownership

Global hold/latch edges still come from the existing gesture controllers. The
mounted practice note owns a lease; gestures alone never set completion flags.
It reuses the production capture → inference → cancellation barrier → BUS-201
own-field insertion path. Cleanup stays off during practice; it does not change
saved cleanup preferences. Practice never falls through to external AX, keyboard
insertion, terminal paste or automatic clipboard Copy. A lost field/window focus,
wrong gesture for the current try, no speech, cancellation, stale lease or an
unconfirmed/copy-only result cannot pass. Manual typing in the note cannot pass.

The lease freezes the model and accepted shortcut and is retired on retry,
permission failure/revocation, configuration change, Back, Close or cancellation.
Permission queries run after slow model verification, with generation and model/
shortcut checks after awaits. Guided practice requires an armed Escape scope;
ordinary product dictation retains its existing degraded-capture behavior.
Escape cancels recording or processing without closing the note. Explicit Close
cancels and closes. Cancelling hands-free keeps a completed hold check. Changing
the shortcut or speech model retires both checks, so tries never silently mix
configurations. Product completion-time targeting and clipboard contracts are
otherwise unchanged.

## Resume and completion

The window's persistent WebView localStorage key `voxloom.guided-setup.v1` holds
only version, step, model/shortcut configuration, tutorial mode and the two result
flags. It does not hold speech text, permissions, engine readiness or registration
claims. Missing/corrupt progress safely starts over; a save error is visible.
Legacy gesture-only flags do not count. Final `onboardingComplete` remains in the
existing durable settings file and is set from Ready after both real result
gates and a fresh prerequisites check, or by an explicit Skip setup on any step
(parity with the earlier Skip), which completes setup without practice so it no
longer reopens at launch. Set up later/Close leave incomplete state, with a
visible Resume setup action that restores saved progress. Finishing or skipping
clears saved progress, and reopening setup from Settings starts it over.
Existing completed users remain complete; they are not silently forced into the
new tutorial or an automatic download.

## Evidence boundary

Automated OS/IPC seams are injected. The isolated browser fixture under
`tests/fixtures/guided-preview.html` is not a production entry point. Browser
checks cover theme, minimum-size geometry, keyboard focus, accessibility and
reduced motion, not native TCC/capture/inference acceptance. Permission grants,
real microphone capture, model downloads, installation/restart and external-app
insertion must be verified separately with explicit authorization. Practice-note
success does not claim every outside app/field supports insertion. No new menu
bar lifecycle is introduced or promised by this tutorial.
