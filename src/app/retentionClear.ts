import { canRetry } from '../domain/records';
import type { AppState } from './state';

/**
 * BUS-78: switching Retention to Off clears loaded transcripts too, not just
 * the file. Shared by `set-setting` (this window) and `hydrate-settings`
 * (a save from the Settings window, or a load), so both paths behave alike.
 * Keeps only failed rows whose recovery window is still open at the
 * action's `now`
 * (Home's paste-again); they expire on their own.
 */
export function recordsAfterSettingsChange(
  state: AppState,
  next: AppState['settings'],
  now: number,
): AppState['records'] {
  if (next.transcriptRetention !== 'off' || state.settings.transcriptRetention === 'off') {
    return state.records;
  }
  return state.records.filter((record) => canRetry(record, now));
}
