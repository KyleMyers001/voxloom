/**
 * BUS-47: while a shortcut recorder is recording (Settings window or
 * onboarding), the global shortcut must not start dictation. The recorder
 * holds a lease; every window learns of it through `shortcut:recording`.
 *
 * It can't get stuck: the recorder ends the lease on save, cancel, blur,
 * unmount and page unload, and a lease that is never ended (crashed or
 * closed window, lost event) expires after LEASE_MS unless renewed.
 */
import { isTauri } from '@tauri-apps/api/core';
import type { ShortcutGesture } from '../contracts';

export const RECORDING_EVENT = 'shortcut:recording';
export const LEASE_MS = 15_000;
export const RENEW_MS = 5_000;

let localCount = 0;
let remoteUntil = 0;
let listening: Promise<unknown> | null = null;

const emit = (on: boolean) => {
  if (!isTauri()) return;
  void import('@tauri-apps/api/event')
    .then(({ emit: send }) => send(RECORDING_EVENT, { on }))
    .catch((err: unknown) => console.error('[shortcut] emit recording failed:', err));
};

/** True while any recorder (this window or another) is recording. */
export function isDictationSuspended(now = Date.now()): boolean {
  return localCount > 0 || now < remoteUntil;
}

/** Start suspending; returns an idempotent end function. */
export function beginRecordingSuspend(): () => void {
  localCount += 1;
  emit(true);
  const renew = setInterval(() => emit(true), RENEW_MS);
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    clearInterval(renew);
    window.removeEventListener('pagehide', end);
    localCount = Math.max(0, localCount - 1);
    emit(false);
  };
  window.addEventListener('pagehide', end);
  return end;
}

function ensureListening() {
  if (listening || !isTauri()) return;
  listening = import('@tauri-apps/api/event')
    .then(({ listen }) => listen<{ on: boolean }>(RECORDING_EVENT, (e) => {
      remoteUntil = e.payload.on ? Date.now() + LEASE_MS : 0;
    }))
    .catch(() => { listening = null; });
}

/**
 * Wrap a gesture handler: drop starts while suspended, and the finish that
 * pairs with a dropped start. A run that began before recording still ends.
 */
export function suspendable(
  handler: (gesture: ShortcutGesture) => void,
  suspended: () => boolean = isDictationSuspended,
): (gesture: ShortcutGesture) => void {
  ensureListening();
  let swallowing = false;
  return (gesture) => {
    const start = gesture === 'hold-start' || gesture === 'latch-start';
    if (start && suspended()) {
      swallowing = true;
      return;
    }
    if (!start && swallowing) {
      swallowing = false;
      return;
    }
    swallowing = false;
    handler(gesture);
  };
}

/** Tests only. */
export function resetRecordingSuspend(): void {
  localCount = 0;
  remoteUntil = 0;
  listening = null;
}
