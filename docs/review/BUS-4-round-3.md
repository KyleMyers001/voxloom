# BUS-4 review round 3 evidence

## Scope and fix

This bounded round changes only app-local shortcut gating. The controller now
accepts a `practice`, `product`, or blocked interaction identity before key
events mutate hold, tap, latch, or timer state. Any identity transition clears
pending timers, timestamps, latch state, active key state, and key-up
suppression, including enabled practice-to-product transitions.

Dialogs publish a small centralized modal count. The app shortcut hook disables
and resets its controller when a modal opens and cleanly enables it after the
last modal closes. Onboarding step three remains the sole intentional modal
exception so its real gesture practice still works.

## Direct evidence

- `shortcutController.test.ts` disables during pending hold and tap windows,
  proves no timer completion leaks, requires a fresh full hold threshold after
  enabling, ignores a disabled tap, and verifies a fresh three-activation latch
  cycle.
- `App.integration.test.tsx` taps inside the Dictionary modal, verifies help and
  navigation suppression, dismisses it, proves the first fresh tap does not
  record, and proves a subsequent hold waits the complete threshold.
- `modalState.test.ts` covers nested modal tracking and notifications.
- `PracticeTransition.integration.test.tsx` proves partial and latched practice
  gestures cannot cross Skip into product interaction. It also proves a fresh
  tap does not record and a fresh hold waits the complete threshold.
- Existing onboarding integration and release-preview journeys verify that the
  intentional step-three exception remains functional.

## Verification

```text
npm run typecheck
npm run lint
npm run test:unit
npm run build
npm run test:e2e
npm run test:e2e:release
git diff --check
```

Final counts are 22 Vitest files / 50 tests, five development-browser
journeys, and one production-preview journey. Native implementation and its
previously disclosed macOS privacy and Windows test limitations are unchanged.

## Implementation audit

`app/modalState.ts` is directly covered by `modalState.test.ts`.
`services/shortcutController.ts` is directly covered by
`shortcutController.test.ts`. `app/useShortcutGestures.ts`, `App.tsx`, and
`Dialog.tsx` are covered by app integration plus existing dialog and browser
journeys. No changed behavior-bearing module exceeds 200 lines.
