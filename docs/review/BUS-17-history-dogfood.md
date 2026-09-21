# BUS-17 dogfood slice — Session History from Dictate

Branch: `bus-17-history-dogfood` (from entitlements codesign on `main`).

Kyle greenlit history polish; Emma/Clara prefer it over deny/revoke. This is a
**session-only** dogfood slice of BUS-17 — not durable disk persistence or
searchable store.

## What landed

| Piece | Behavior |
|-------|----------|
| `createDogfoodRecord` | Builds a `DictationRecord` from dogfood STT (+ Copy) |
| Status | `copied` when clipboard write succeeded; `failed` when Copy soft-failed but transcript text exists (honest) |
| Blank transcript | Returns `null` — no History / Recent row (blank-audio flake guard) |
| `append-record` | Prepends the row onto `state.records` (session only) |
| `useDogfoodCapture` | Calls `onHistoryRecord` after non-blank success |
| Home | Dispatches `append-record` with current style + clock |
| Cancel / STT error | No history row |

Model id is not on `DictationRecord` yet (History UI still shows the fixture
label). Duration comes from capture `duration_ms`; style from Settings.

## Clara smoke (Mac)

```sh
npm install
npm run tauri -- dev -- --features whisper
```

1. Settings → Speech-to-text models → Download tiny (if needed) → select it.
2. Prefer **Scenario → Empty** (or clear Recent) so new rows are obvious.
3. Home → **Dictate** → **Start capture** → speak → **Stop**.
4. Expect copy toast, then the transcript in **Recent dictations** with status
   path `copied` under History (View all → filter Copied / All).
5. **Start → Cancel** → Recent / History must **not** gain a new row.
6. Soft-fail Copy (rare with native clipboard): transcript still shows; History
   gets a `failed` row with the real text (Recent hides `failed` by design).

## Verification (Linux CI / box)

```sh
npm run typecheck
npm run lint
npm run test:unit
```

## Out of scope

- Disk persistence / searchable durable history (full BUS-17)
- Insert-into-app / shortcuts / overlay (BUS-12–14)
- Deny/revoke TCC, signing changes
