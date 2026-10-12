# Contributing to Voxloom

## Store backwards-compatibility rule

Voxloom keeps user data in JSON stores (`settings.json`, `history.json`,
`dictionary.json`). Any change to what these files hold must stay backwards
compatible:

1. **Every new setting or store field has a default.** A file written before
   the field existed must load with that default filled in.
2. **Older files are always read and migrated, never rejected.** Bump the
   file `version` when the shape changes, and add a migration from every
   earlier version. Never treat an older version as unreadable.
3. **Unknown fields are kept, not dropped**, so a newer build's data survives
   a round trip through an older one.
4. **Nothing is written over a file that couldn't be read.** Back it up first
   (see BUS-42) or leave it untouched.
5. **Add a test with a fixture from the previous version** (see
   `tests/fixtures/history-v2.json` and `tests/unit/historyVersionCompat.test.tsx`).

Why: BUS-42. A history file saved in a newer format by an unmerged branch was
rejected as unreadable, and History came up empty.
