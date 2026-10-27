import type { Dispatch, MutableRefObject } from 'react';
import type { AppAction } from './actions';

/**
 * history.json could not be read: never write over it (CONTRIBUTING store
 * rule 4). Disables history writes for the rest of the session and shows a
 * sticky error. Shared by the boot, rollback-reload and delete-patch paths.
 */
export function blockHistoryWrites(
  allowRef: MutableRefObject<boolean>,
  dispatch: Dispatch<AppAction>,
  message: string,
) {
  allowRef.current = false;
  dispatch({ message, sticky: true, type: 'set-history-error' });
}
