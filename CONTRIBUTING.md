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
3. **Unknown keys in `settings.json`'s `settings` object are kept.** Other
   stores keep only known fields, so back up before any rewrite that drops
   data.
4. **Settings and dictionary may be reset only after a byte-exact backup
   succeeds.** History that can't be read is never written. With no backup,
   leave the file untouched.
5. **Add a test with a fixture from the previous version** (see
   `tests/fixtures/history-v2.json` and `tests/unit/historyVersionCompat.test.tsx`).
6. **Files from a newer or unknown version are left untouched and writes
   stay blocked.** A known sibling version (history v2) is migrated only
   after a backup.

Why: BUS-42. A history file saved in a newer sibling version by an unmerged branch was
rejected as unreadable, and History came up empty.
