# BUS-11 dogfood slice — Durable Word dictionary CRUD

Branch: `bus-11-dictionary-persistence` (from main after Settings persistence).

Makes the **canonical Word dictionary** survive quit → relaunch. Settings
persistence shipped earlier; this slice finishes the BUS-11 durable store
story for dictionary CRUD (no aliases / import / export / cloud / sync).

## How persistence works

| Piece | Behavior |
|-------|----------|
| Path | Tauri `app_data_dir/dictionary.json` via `dictionary_load` / `dictionary_save` |
| Format | `{ "version": 1, "words": string[] }` (single trimmed Word field per entry) |
| Write | Atomic temp + rename (`dictionary.json.tmp` → `dictionary.json`) |
| Boot | Empty in-memory list → load → `hydrate-words` |
| Add / edit / delete | Reducer updates `state.words` → persist effect saves |
| Validation | Case-insensitive duplicate prevention; blank/whitespace errors; edit-to-same-word ok |
| Corrupt / missing | Safe empty + toast; **never** touches `settings.json` or `history.json` |
| Non-Tauri | Persistence disabled (browser / unit tests stay memory-only; fixture seed remains) |

Delete follows the existing Dictionary UI (immediate, no confirmation/undo).
Session-only delete is not claimed as durable safety beyond the persist write.

## Apply strategy

**Optimistic UI with rollback on durable write failure.** Add/edit/delete update
the reducer immediately; the persist effect writes `dictionary.json` and, on
failure, re-hydrates the last successful snapshot and toasts.

## AC coverage

1. Approved words survive quit→relaunch — **yes**
2. Case-insensitive search / empty state — **unchanged UI**
3. Duplicate prevention (case-insensitive); edit-to-same valid — **yes**
4. Blank/whitespace + duplicate errors accessible/recoverable — **yes** (existing dialog `role="alert"`)
5. Delete sticks when durable write succeeds — **yes**
6. Atomic writes; corrupt/missing → empty + toast; never wipe settings/history — **yes**
7. No aliases/import/export/cloud/sync — **out of scope**
8. Unit tests for CRUD validation + store load/save/corrupt — **yes**
9. Clara smoke below — **yes**

## Clara smoke (Mac)

```sh
npm install
npm run tauri -- dev -- --features whisper
```

1. Dictionary → **Add term** → enter a unique word (e.g. `ClaraSmoke`) → Save.
2. Quit the app fully → relaunch → **Dictionary still shows `ClaraSmoke`**.
3. Delete `ClaraSmoke` → quit → relaunch → word stays gone.
4. Add `DupTest` → try adding `duptest` → accessible error; fix or Cancel recovers.
5. Edit an existing word to the **same** spelling → Save succeeds.
6. Optional: confirm Settings retention and History rows still load (sibling files untouched).

## Verification (Linux CI / box)

```sh
npm run typecheck
npm run lint
npm run test:unit
```

## Residual risks

- Cold-start empty-list flash for Dictionary is addressed by
  `BUS-boot-hydrate-polish.md` (`bootReady` gate).
- Corrupt `dictionary.json` recovers to empty on next successful save; no
  dedicated recovery UI.
- Browser / Vite-only shells stay memory-only (documented).
- Immediate delete has no undo; durability is “write succeeded,” not soft-delete.
