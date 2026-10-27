import type { Dispatch, MutableRefObject } from 'react';
import type { AppAction } from './actions';

export interface HistoryWriteGate {
  /** False while history.json writes are disabled. */
  allowRef: MutableRefObject<boolean>;
  /** True only when writes were disabled because history.json was unreadable. */
  loadBlockedRef: MutableRefObject<boolean>;
}

/**
 * history.json could not be read: never write over it (CONTRIBUTING store
 * rule 4). Disables history writes and shows a sticky error. Shared by the
 * boot, rollback-reload and delete-patch paths.
 */
export function blockHistoryWrites(
  gate: HistoryWriteGate,
  dispatch: Dispatch<AppAction>,
  message: string,
) {
  gate.allowRef.current = false;
  gate.loadBlockedRef.current = true;
  dispatch({ message, sticky: true, type: 'set-history-error' });
}

/**
 * history.json was read successfully after an unreadable load, so memory now
 * matches disk and saving is safe again. Blocks that have another cause (the
 * read-only boot states) are left alone.
 */
export function reallowHistoryWritesAfterLoad(gate: HistoryWriteGate) {
  if (!gate.loadBlockedRef.current) return;
  gate.loadBlockedRef.current = false;
  gate.allowRef.current = true;
}
