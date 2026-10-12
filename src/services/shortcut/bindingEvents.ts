/**
 * BUS-47: the main window owns native registration. After each attempt it
 * broadcasts the result so the Settings recorder announces success only once
 * the OS accepted the combo, and the honest failure otherwise.
 */
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '@tauri-apps/api/core';

export const SHORTCUT_BOUND_EVENT = 'shortcut:bound';

export interface ShortcutBoundPayload {
  /** Settings-format shortcut that was attempted. */
  shortcut: string;
  ok: boolean;
  /** Settings-format combo the OS holds after this attempt (revert target). */
  active?: string | null;
  message?: string;
}

export function emitShortcutBound(payload: ShortcutBoundPayload): void {
  if (!isTauri()) return;
  // Best-effort: a lost event only leaves the recorder on "Setting…".
  void import('@tauri-apps/api/event')
    .then(({ emit }) => emit(SHORTCUT_BOUND_EVENT, payload))
    .catch(() => {});
}

export async function listenShortcutBound(
  handler: (payload: ShortcutBoundPayload) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<ShortcutBoundPayload>(SHORTCUT_BOUND_EVENT, (e) => handler(e.payload));
}
