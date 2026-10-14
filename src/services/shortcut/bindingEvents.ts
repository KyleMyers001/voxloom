/**
 * BUS-47: the main window owns native registration. After each attempt it
 * broadcasts the result so the Settings recorder announces success only once
 * the OS accepted the combo, and the honest failure otherwise. `active: null`
 * tells every window that no shortcut is held. A Settings window that opens
 * later asks for the last result with `shortcut:query`.
 */
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '@tauri-apps/api/core';
import { setActiveShortcut } from './activeShortcut';

export const SHORTCUT_BOUND_EVENT = 'shortcut:bound';
export const SHORTCUT_QUERY_EVENT = 'shortcut:query';

export interface ShortcutBoundPayload {
  /** Settings-format shortcut that was attempted. */
  shortcut: string;
  ok: boolean;
  /** Settings-format combo the OS holds after this attempt (null: nothing). */
  active?: string | null;
  /** On a refusal: the combo held before this attempt (what restore tried). */
  previous?: string | null;
  message?: string;
  /** A re-send of the last result for a late listener, not a new attempt. */
  replay?: boolean;
}

let last: ShortcutBoundPayload | null = null;

const emitEvent = (name: string, payload: unknown) => {
  if (!isTauri()) return;
  // A lost event leaves the recorder on "Setting…", so log it instead of
  // hiding it (e.g. a capability missing core:event:allow-emit).
  void import('@tauri-apps/api/event')
    .then(({ emit }) => emit(name, payload))
    .catch((err: unknown) => {
      console.error(`[shortcut] emit ${name} failed:`, err);
    });
};

export function emitShortcutBound(payload: ShortcutBoundPayload): void {
  last = payload;
  setActiveShortcut(payload.active === undefined && payload.ok ? payload.shortcut : payload.active);
  emitEvent(SHORTCUT_BOUND_EVENT, payload);
}

/** Main window: answer Settings' query with the last result. */
export async function answerShortcutQueries(): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen(SHORTCUT_QUERY_EVENT, () => {
    if (last) emitEvent(SHORTCUT_BOUND_EVENT, { ...last, replay: true });
  });
}

/** Settings window: ask main to replay the last result. */
export function queryShortcutBound(): void {
  emitEvent(SHORTCUT_QUERY_EVENT, null);
}

export async function listenShortcutBound(
  handler: (payload: ShortcutBoundPayload) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<ShortcutBoundPayload>(SHORTCUT_BOUND_EVENT, (e) => handler(e.payload));
}

/** Tests only. */
export function resetLastShortcutBound(): void {
  last = null;
}
