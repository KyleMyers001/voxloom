/**
 * BUS-47: the recorder's registration bookkeeping, kept at module level so it
 * outlives the component. Switching Settings tabs while "Setting…" is shown
 * remounts the recorder; the result that lands meanwhile is still applied
 * (revert) and the remounted recorder shows it.
 */
import { useSyncExternalStore } from 'react';
import { setActiveShortcut } from '../../services/shortcut/activeShortcut';
import {
  listenShortcutBound, queryShortcutBound, type ShortcutBoundPayload,
} from '../../services/shortcut/bindingEvents';
import { inUseText, noneActiveText, successText, timeoutText } from './shortcutCopy';

export type Status = { tone: 'error' | 'info' | 'ok'; text: string } | null;

/** How long "Setting…" waits for the main window's result. */
export const CONFIRM_TIMEOUT_MS = 5000;

const s = {
  /** Last combo confirmed registered; the revert target (null: none active). */
  confirmed: undefined as string | null | undefined,
  /** Combo whose confirmation timed out; a late result still updates status. */
  late: null as string | null,
  listening: null as Promise<() => void> | null,
  /** Saves a combo; the latest mounted recorder's onChange. */
  onChange: null as ((combo: string) => void) | null,
  /** Combo awaiting the main window's native registration result. */
  pending: null as string | null,
  status: null as Status,
  timer: null as ReturnType<typeof setTimeout> | null,
};
const listeners = new Set<() => void>();

export function setRecorderStatus(next: Status): void {
  s.status = next;
  listeners.forEach((fn) => fn());
}

function clearPending() {
  s.pending = null;
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
}

/** The status still claims `combo` was set (a same-combo save shows it at once). */
function sameComboSaved(combo: string): boolean {
  return s.pending === null && s.status?.tone === 'ok' && s.status.text === successText(combo);
}

function onBound({ active, ok, previous, replay, shortcut }: ShortcutBoundPayload) {
  // Track what the OS holds from every result, even superseded ones, so a
  // late ok for A still makes A the revert target when B is refused.
  const before = s.confirmed;
  if (ok) s.confirmed = shortcut;
  else if (active !== undefined) s.confirmed = active;
  setActiveShortcut(ok && active === undefined ? shortcut : active);
  if (!replay && !ok && active === null && sameComboSaved(shortcut)) {
    // BUS-74: re-recording the current combo skips "Setting…", so a failed
    // re-bind afterwards must replace its "Shortcut set to …" line.
    setRecorderStatus({ text: noneActiveText(shortcut, null), tone: 'error' });
    return;
  }
  if (replay || (s.pending !== shortcut && s.late !== shortcut)) return;
  clearPending();
  s.late = null;
  if (ok) {
    setRecorderStatus({ text: successText(shortcut), tone: 'ok' });
    return;
  }
  const kept = s.confirmed;
  // Never keep a refused combo. With nothing active, keep the previous one
  // in settings so the next launch retries it.
  const restore = previous ?? before;
  const target = kept ?? restore;
  if (target && target !== shortcut) s.onChange?.(target);
  setRecorderStatus({
    text: kept === null ? noneActiveText(shortcut, restore) : inUseText(shortcut, target ?? shortcut),
    tone: 'error',
  });
}

/** Called by each mounted recorder; starts the window-lifetime listener once. */
export function attachRecorder(value: string, onChange: (combo: string) => void): void {
  s.onChange = onChange;
  if (s.confirmed === undefined) s.confirmed = value;
  if (s.listening) return;
  s.listening = listenShortcutBound(onBound);
  void s.listening.then(() => queryShortcutBound()).catch(() => {});
}

/** Wait for the main window's result for `combo`, timing out to a hint. */
export function beginPending(combo: string): void {
  clearPending();
  s.late = null;
  s.pending = combo;
  s.timer = setTimeout(() => {
    if (s.pending !== combo) return;
    s.late = combo;
    clearPending();
    setRecorderStatus({ text: timeoutText(combo), tone: 'error' });
  }, CONFIRM_TIMEOUT_MS);
}

export function cancelPending(): void {
  clearPending();
}

function subscribeStatus(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export const useRecorderStatus = (): Status =>
  useSyncExternalStore(subscribeStatus, () => s.status, () => s.status);

/** Tests only: forget everything, including the event listener. */
export function resetRecorderStore(): void {
  clearPending();
  Object.assign(s, { confirmed: undefined, late: null, listening: null, onChange: null, status: null });
  listeners.forEach((fn) => fn());
}
