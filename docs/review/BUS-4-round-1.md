# BUS-4 review round 1 evidence

## Scope

This round addresses the accepted review findings without adding native audio,
global shortcuts, inference, insertion, model downloads, network services, or
production persistence. The configured shortcut works only while the Voxloom
window is focused. All fixtures remain synthetic and reset on reload.

## Implementation-surface audit

| Runtime module | Direct evidence |
| --- | --- |
| `app/state.ts`, `app/initialState.ts` | `state.test.ts` |
| `app/App.tsx`, `app/AppContext.tsx` | `App.integration.test.tsx` |
| `app/useShortcutGestures.ts` | app integration and controller tests |
| `app/useTheme.ts` | `theme.test.ts` and browser media assertions |
| `components/Dialog.tsx` | `Dialog.test.tsx` |
| `components/Waveform.tsx` | `Waveform.test.tsx` |
| `dev/ScenarioPanel.tsx` | `ScenarioPanel.test.tsx` |
| `domain/dictationMachine.ts` | `dictationMachine.test.ts` |
| `domain/dictionary.ts` | `dictionary.test.ts` |
| `domain/fixtures.ts` | `fixtures.test.ts` |
| `domain/records.ts` | `records.test.ts` |
| `domain/settings.ts` | `settings.test.ts`, `settings.types.ts` |
| `features/dictionary/Dictionary.tsx` | `Dictionary.test.tsx` |
| `features/history/History.tsx` | `History.test.tsx` |
| `features/home/Home.tsx` | `Home.test.tsx` |
| `features/onboarding/Onboarding.tsx` | onboarding and app tests |
| `features/settings/Settings.tsx` | `Settings.test.tsx` |
| `services/clipboard.ts` | `clipboard.test.ts` |
| `services/mock/dictationService.ts` | `dictationService.test.ts` |
| `services/shortcutController.ts` | `shortcutController.test.ts` |

`Toast.tsx`, `main.tsx`, Tauri entry points, and configuration are trivial
wiring. `types.ts`, styles, icons, and desktop-shell documentation have no
runtime behavior requiring direct tests. Cross-screen mutations and first-run
gating are covered by both app integration and Playwright journeys.

## State and interaction evidence

- Shortcut tests use injected time and independently cover hold/release, rapid
  double-tap latch/finish, and repeat suppression.
- App integration drives onboarding and dictation with keyboard events rather
  than test buttons.
- Reducer tests cover legal transitions, stale success/failure/cancel, retry
  cancellation and repetition, duplicate completion, and atomic source-record
  replacement.
- History tests advance the injected clock and interval directly; expiry does
  not depend on search or another unrelated render. A race at activation gives
  explicit expired feedback.
- Dialog tests cover Escape, tab wrap, app inertness, cleanup, backdrop close,
  safe panel interaction, and opener restoration.
- Typecheck contains a negative compile assertion proving that a Boolean
  setting cannot receive a string.

## Browser and visual evidence

Playwright checks first-run gestures, all four screens, all four appearances,
System light/dark media changes and computed tokens, onboarding/help dialogs,
axe scans, reduced motion, coarse-pointer action visibility, retry expiry, and
the 640-pixel layout.

The 16 baseline files use this naming scheme:

`artifacts/screenshots/baseline-<screen>-<appearance>.png`

Additional screenshots cover onboarding, listening, failed recovery, empty
state, and coarse narrow layout. They were visually compared with the staged
approved HTML for Quiet Signal hierarchy, rail/content proportions, action
placement, bottom-center waveform, dialog fit, theme tokens, and clipping.
Four `reference-approved-<screen>.png` captures preserve the exact staged HTML
views used for the side-by-side dark-theme inspection.

## Quality and limits

No behavior-bearing handwritten module exceeds 200 lines. Modules in the
100-200 line range remain cohesive reducers, screen components, the app shell,
or one gesture controller; splitting their single interaction responsibility
would add indirection without separating a domain concern. Handwritten source
and tests stay within 80 columns.

The macOS Tauri shell has no application capabilities or Rust commands. The
native process and window launch can be smoke-tested, but host Screen Recording
and Accessibility privacy policy prevents automated native screenshots and the
full desktop interaction journey. Windows remains untested.
