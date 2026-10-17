import { canRetry } from '../domain/records';
import type { AppState } from './state';

/**
 * BUS-78: switching Retention to Off clears loaded transcripts too, not just
 * the file. Shared by `set-setting` (this window) and `hydrate-settings`
 * (a save from the Settings window, or a load), so both paths behave alike.
 * Keeps only failed rows whose recovery window is still open at the
 * action's `now` (Home's paste-again).
 *
 * Disk wipe is deferred until Off is confirmed on settings.json (see
 * AppContext history persist). A failed local Off save reloads records from
 * disk — no in-memory stash — so memory and disk cannot drift.
 */
export function recordsAfterSettingsChange(
  state: AppState,
  next: AppState['settings'],
  now: number,
): AppState['records'] {
  if (next.transcriptRetention !== 'off' || state.settings.transcriptRetention === 'off') {
    return state.records;
  }
  return keepRecoverable(state.records, now);
}

/** Rows Retention Off may still hold in memory: recoverable failed rows. */
export function keepRecoverable(
  records: AppState['records'],
  now: number,
): AppState['records'] {
  return records.filter((record) => canRetry(record, now));
}

/**
 * `hydrate-records` can land after Off already arrived (e.g. from the
 * Settings window before main's first history load); filter the same way.
 */
export function recordsForRetention(
  settings: AppState['settings'],
  records: AppState['records'],
  now: number,
): AppState['records'] {
  return settings.transcriptRetention === 'off' ? keepRecoverable(records, now) : records;
}
