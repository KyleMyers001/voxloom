# Boot hydrate polish — Settings / History / Dictionary gate

Branch: `boot-hydrate-polish` (from main @ dictionary durable `17c3459`).

Removes the cold-start flash where Settings showed fixture defaults (and
History / Dictionary showed empty lists) before durable hydrate finished.

## Behavior

| Piece | Behavior |
|-------|----------|
| Flag | `bootReady` on `AppProvider` / `useApp()` |
| Starts false | When any of settings / history / dictionary durable persistence is on |
| Starts true | Browser / jsdom memory-only (no durable IO) |
| Becomes true | After settings → dictionary → history initial load attempts settle |
| Fail-safe | Corrupt/missing still toasts + defaults/empty; **still** sets `bootReady` so UI is never stuck |
| UI gate | Settings / History / Dictionary render a short “Loading…” placeholder (`role="status"`) until ready; Home unchanged |

Sibling stores remain independent: a corrupt `settings.json` never wipes
`history.json` / `dictionary.json` (unchanged BUS-11 / BUS-17 contracts).

## AC coverage

1. No flash of fixture retention / theme / words / history seed before hydrate — **yes** (gated surfaces)
2. Ready after success **or** fail-safe toast path — **yes**
3. Unit tests with deferred async load prove Loading… then hydrated values — **yes**
4. No silent cloud STT / model download — **unchanged**

## Clara smoke (Mac, optional)

```sh
npm install
npm run tauri -- dev -- --features whisper
```

1. With existing durable settings/history/dictionary, quit → relaunch.
2. Immediately open Settings / History / Dictionary: either a brief Loading…
   or the real disk values — **never** fixture retention (`30-days` when disk
   says otherwise) or fixture dictionary words.
3. Corrupt one file (optional): toast + defaults/empty for that store only;
   other screens still load; UI does not stay on Loading… forever.

## Verification (Linux CI / box)

```sh
npm run typecheck
npm run lint
npm run test:unit
```

Vite-only (`npm run dev`) stays memory-only: `bootReady` is immediate.

## Residual risks

- Home Recent can still briefly show empty while history hydrates (out of
  scope; History screen is gated). Onboarding may still open then close when
  durable `onboardingComplete` is true (same class; not gated here).
- Extremely slow disk: Loading… remains until IO settles (intentional).
