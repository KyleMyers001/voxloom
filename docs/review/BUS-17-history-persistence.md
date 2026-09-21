# BUS-17 — Disk persistence for History / Recent

Branch: `bus-17-history-persistence` (from main @ dogfood slice `663ca0c`).

Makes dictation History / Home Recent **durable across app restarts**. Session
dogfood wiring from the prior BUS-17 slice is unchanged; this PR adds store
load/save.

## How persistence works

| Piece | Behavior |
|-------|----------|
| Path | Tauri `app_data_dir/history.json` via `history_load` / `history_save` |
| Format | `{ "version": 1, "records": DictationRecord[] }` (includes `model`) |
| Write | Atomic temp + rename (`history.json.tmp` → `history.json`) |
| Boot | Empty in-memory list → load → `hydrate-records` |
| Append / delete | Reducer updates `state.records` → persist effect saves |
| Retention | Honors Settings `transcriptRetention`: `off` writes empty; `30-days` filters by `createdAt`; `forever` keeps all |
| Corrupt file | Load error toast; **no overwrite**; in-memory stays empty until fixed |
| Non-Tauri | Persistence disabled (browser / unit tests keep fixture seed) |

Out of scope (follow-ups, not invented here): settings UI redesign, audio
retention, insert-into-app, shortcuts, TCC, notarization. Retention control
already exists under Settings → transcript retention.

## AC coverage

1. Persist text, status, duration, model, style, timestamp, delivery outcome — **yes**
2. Load into `state.records` on start; Home Recent newest non-failed — **yes**
3. History search/filters on persisted data — **yes** (same `state.records`)
4. Individual delete persists — **yes**
5. Retention off honored — **yes** (no durable transcripts)
6. Store failure fail-safe — **yes** (toast + no wipe)
7. No silent model download — **unchanged** (local-first)

## Clara smoke (Mac)

```sh
npm install
npm run tauri -- dev -- --features whisper
```

1. Settings → STT models → ensure tiny downloaded + selected.
2. Settings → transcript retention → **30 days** or **Forever** (not Off).
3. Prefer **Scenario → Empty lists** so Recent is blank.
4. Home → **Dictate** → Start → speak → Stop → expect Copy toast + Recent row.
5. Quit the app fully → relaunch → **Recent** and **History** still show the row;
   History search/filters still work.
6. History → Delete the row → quit → relaunch → row stays gone.
7. **Start → Cancel** → no new row (unchanged).
8. Optional: Settings → transcript retention → **Off** → quit → relaunch →
   durable list empty (session rows from before Off are not reloaded).

## Verification (Linux CI / box)

```sh
npm run typecheck
npm run lint
npm run test:unit
```

## Residual risks

- DEV **Reset session** reseeds fixture history and can overwrite durable
  `history.json` while Tauri persistence is enabled — prefer Empty lists /
  Delete for smoke, not Reset.
- Settings themselves are not durable yet (retention returns to default on
  relaunch until a settings-persistence ticket).
- No automatic recovery UI for a corrupt `history.json` (manual delete of the
  file recovers empty history).
