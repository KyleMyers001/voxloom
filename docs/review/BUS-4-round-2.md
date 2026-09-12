# BUS-4 review round 2 evidence

## Scope

This round addresses the five accepted review findings without adding native
audio, global shortcuts, inference, insertion, persistence, network services,
or Tauri capabilities. All gestures remain focused-window simulations.

## Finding coverage

1. Retry now starts only from ready or terminal dictation states. Reducer and
   browser regressions prove that History cannot replace a listening run.
2. Hold and double-tap practice statuses always render. Only fallback buttons
   are development-only. A production-preview journey proves independent real
   gestures, Finish gating, and absence of development controls.
3. Context exposes narrow typed adapters for History deletion, Dictionary
   CRUD, Settings updates, and setup/onboarding mutations. Product components
   consume these adapters; reducer actions remain behind the mock boundaries.
4. Reopening setup resets step, practice, collision, denial, and recognized
   text while preserving granted session permission and the configured
   shortcut. Reset session still restores all initial fixtures and permission.
5. Recording, help, and navigation shortcuts are suppressed while any modal
   dialog is open. Intentional onboarding practice remains active only at step
   three. Escape remains robust if a step change leaves focus on the body.

## Implementation-surface audit

| Runtime module | Meaningful direct evidence |
| --- | --- |
| `app/state.ts` | `state.test.ts` retry and reopen/reset cases |
| `app/App.tsx`, `app/AppContext.tsx` | `App.integration.test.tsx` |
| `app/useShortcutGestures.ts` | app integration and controller tests |
| `components/Dialog.tsx` | `Dialog.test.tsx`, app modal suppression test |
| `features/dictionary/Dictionary.tsx` | `Dictionary.test.tsx` |
| `features/history/History.tsx` | `History.test.tsx`, browser active-run test |
| `features/home/Home.tsx` | `Home.test.tsx`, app integration |
| `features/onboarding/Onboarding.tsx` | onboarding and browser tests |
| `features/settings/Settings.tsx` | `Settings.test.tsx`, app integration |
| `services/mock/appServices.ts` | `appServices.test.ts` |

`app/actions.ts`, `services/contracts.ts`, and the additions to
`domain/types.ts` are type-only. Their key/value correlation is checked by
`settings.types.ts` during typecheck. Playwright configuration and package
scripts are test wiring. Existing unchanged modules retain the round-one audit.

No behavior-bearing handwritten module exceeds 200 lines. `state.ts` is 188
lines after moving action declarations to a type-only module. The 100-200-line
screen and reducer modules remain cohesive single-responsibility units.

## Verification

Final commands:

```text
npm run typecheck
npm run lint
npm run test:unit
npm run build
npm run test:e2e
npm run test:e2e:release
cargo check --manifest-path src-tauri/Cargo.toml
git diff --check
```

Final counts are 20 Vitest files / 45 tests, five development-preview
Playwright journeys, and one production-preview journey. The browser matrix
continues to exercise 16 screen/appearance captures, axe, System media tokens,
reduced motion, narrow layout, and coarse pointers.

The browser suite refreshed screenshot evidence. Representative onboarding,
Home, and History images were manually inspected for clipping, hierarchy, and
action visibility; this is manual review, not automated pixel-diff approval.

## Accepted limits

macOS Screen Recording and Accessibility privacy policy still prevents a full
native interaction capture. The command-free Tauri shell is compile-checked;
Windows remains untested. All application data remains session-only.
