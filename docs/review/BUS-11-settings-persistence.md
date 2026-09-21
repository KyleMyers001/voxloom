# BUS-11 dogfood slice — Durable Settings

Branch: `bus-11-settings-persistence` (from main @ Reset-vs-store `6798998`).

Makes **Settings** (especially transcript retention and other already-approved
controls) **survive quit → relaunch**. Residual after BUS-17 history persist:
settings themselves were still session-only.

## How persistence works

| Piece | Behavior |
|-------|----------|
| Path | Tauri `app_data_dir/settings.json` via `settings_load` / `settings_save` |
| Format | `{ "version": 1, "onboardingComplete": boolean, "settings": Settings }` |
| Write | Atomic temp + rename (`settings.json.tmp` → `settings.json`) |
| Boot | Load settings → `hydrate-settings` → then load history with hydrated retention |
| Updates | Optimistic UI (`set-setting` / onboarding complete) → persist effect |
| Save failure | Toast + **rollback** to last successful save |
| Corrupt / missing | Safe defaults + toast; **never** touches `history.json` |
| Non-Tauri | Persistence disabled (browser / unit tests stay memory-only) |

Persisted keys (full `Settings` object + flag):

- `transcriptRetention` (`30-days` / `forever` / `off`)
- `appearance` (theme)
- `transcriptionModel` (STT model id)
- `style`, `microphone`, `audioRetention`
- `shortcut`, `language`, `languageModel`
- `clipboardFallback`, `startAtLogin`
- `onboardingComplete` (envelope flag → `onboarding.complete`)

## Apply strategy

**Optimistic UI with rollback on durable write failure.** The Settings UI
updates immediately via the reducer; the persist effect writes `settings.json`
and, on failure, re-hydrates the last successful snapshot and toasts.

## AC coverage

1. Settings survive quit→relaunch (retention, theme, STT model, style, mic,
   onboarding-complete) — **yes**
2. Apply strategy documented (optimistic + rollback) — **yes**
3. Corrupt/missing → defaults + toast; no silent history wipe; atomic write —
   **yes**
4. No silent model download; no new cloud path — **unchanged**
5. Retention change still filters/persists history; choice remains after
   relaunch — **yes** (settings hydrate before history load)
6. Unit tests for load/save/corrupt/defaults — **yes**
7. Clara smoke below — **yes**

## Deferred (follow-up)

- Canonical **Word dictionary durable CRUD** (BUS-11 full story). In-memory
  dictionary words remain session-only in this slice.

## Clara smoke (Mac)

```sh
npm install
npm run tauri -- dev -- --features whisper
```

1. Settings → transcript retention → **Until deleted** (or **Off** / **30 days**).
2. Optionally change theme, style, and STT model selection (no Download click
   required for this check).
3. Quit the app fully → relaunch → **Settings still shows the same retention
   (and other changed values)**.
4. Dictate path unchanged: Home → Dictate → Start → speak → Stop → Copy toast +
   Recent row; History still works.
5. Change retention again → quit → relaunch → new choice still selected;
   history list still honors retention.
6. Optional: complete/skip onboarding once → quit → relaunch → onboarding
   should not force open again (`onboardingComplete` persisted).

## Verification (Linux CI / box)

```sh
npm run typecheck
npm run lint
npm run test:unit
```

## Residual risks

- Dictionary words are not durable yet (explicit follow-up).
- Brief flash of fixture defaults is possible before settings hydrate on cold
  start (same class of race as history empty→hydrate).
- Corrupt `settings.json` recovers to defaults on next successful save; no
  dedicated recovery UI.
- Browser / Vite-only shells stay memory-only (documented).
