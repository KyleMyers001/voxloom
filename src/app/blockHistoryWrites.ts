import type { Dispatch, MutableRefObject } from 'react';
import type { AppAction } from './actions';

/**
 * Why history writes are off (null: they are on).
 * - `load`: a boot or rollback-reload load could not read history.json. A
 *   later successful reload lifts it.
 * - `permanent`: read-only boot states and delete-patch blocks. Nothing
 *   lifts it for the session: a reload could revive rows the user deleted, or
 *   a save could prune a file that was never backed up.
 */
export type HistoryBlockReason = 'load' | 'permanent' | null;

export interface HistoryWriteGate {
  /** False while history.json writes are disabled. */
  allowRef: MutableRefObject<boolean>;
  reasonRef: MutableRefObject<HistoryBlockReason>;
  /** The sticky error that explains the current block. */
  messageRef: MutableRefObject<string | null>;
}

/**
 * history.json must not be written (CONTRIBUTING store rule 4, unreadable or
 * read-only history). Disables history writes and shows a sticky error. A
 * `permanent` reason is never downgraded by a later `load` block.
 */
export function blockHistoryWrites(
  gate: HistoryWriteGate,
  dispatch: Dispatch<AppAction>,
  message: string,
  reason: 'load' | 'permanent',
) {
  gate.allowRef.current = false;
  if (gate.reasonRef.current !== 'permanent') {
    gate.reasonRef.current = reason;
    gate.messageRef.current = message;
  }
  showHistoryBlockError(gate, dispatch);
}

/**
 * Re-show the sticky error while writes are still off: hydrating records
 * clears the history error, which must not hide a block that remains.
 */
export function showHistoryBlockError(
  gate: HistoryWriteGate,
  dispatch: Dispatch<AppAction>,
) {
  if (gate.allowRef.current || gate.messageRef.current === null) return;
  dispatch({ message: gate.messageRef.current, sticky: true, type: 'set-history-error' });
}

/**
 * history.json was read successfully after an unreadable load, so memory now
 * matches disk and saving is safe again. Blocks with any other reason stay.
 */
export function reallowHistoryWritesAfterLoad(gate: HistoryWriteGate) {
  if (gate.reasonRef.current !== 'load') return;
  gate.reasonRef.current = null;
  gate.messageRef.current = null;
  gate.allowRef.current = true;
}
