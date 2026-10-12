import type { DictationRecord } from '../domain/types';

/**
 * BUS-45: dictations can finish before durable history has loaded at boot.
 * Until `hydrate-records` lands, every row in `state.records` was created in
 * this session (persisted history starts empty), so those rows are the
 * pre-hydrate queue. On hydrate they are kept, newest first, ahead of the
 * loaded rows instead of being replaced by them.
 *
 * Writing is still gated by AppContext (historyHydratedRef /
 * allowHistoryPersistRef, BUS-42): when history is read-only or blocked the
 * queued rows are shown in memory but never saved.
 */
export function mergePreHydrateRecords(
  loaded: readonly DictationRecord[],
  pending: readonly DictationRecord[],
): DictationRecord[] {
  if (pending.length === 0) return [...loaded];
  return [...pending, ...loaded];
}

/** Records queued before hydrate, or none once history has hydrated. */
export function pendingPreHydrateRecords(
  historyHydrated: boolean,
  records: readonly DictationRecord[],
): DictationRecord[] {
  return historyHydrated ? [] : [...records];
}
