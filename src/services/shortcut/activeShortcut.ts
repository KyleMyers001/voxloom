/**
 * BUS-47: what the OS actually holds, per window. The main window sets it from
 * every registration attempt; Settings learns it from `shortcut:bound`.
 * `null` means a refusal whose restore also failed: no shortcut is active,
 * even though settings keep the combo so the next launch retries it.
 * `undefined` means "not reported yet" and is treated as active.
 */
import { useSyncExternalStore } from 'react';

let active: string | null | undefined;
const listeners = new Set<() => void>();

export function getActiveShortcut(): string | null | undefined {
  return active;
}

export function setActiveShortcut(next: string | null | undefined): void {
  if (next === undefined || next === active) return;
  active = next;
  listeners.forEach((fn) => fn());
}

function subscribeActive(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** False only when registration reported that nothing is active. */
export function useShortcutActive(): boolean {
  return useSyncExternalStore(subscribeActive, () => active !== null, () => true);
}

/** Tests only. */
export function resetActiveShortcut(): void {
  active = undefined;
  listeners.forEach((fn) => fn());
}
