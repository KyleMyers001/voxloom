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
/** Per-window lease expiry, keyed by the sender's window id. */
const remote = new Map<string, number>();
const WINDOW_ID = globalThis.crypto?.randomUUID?.() ?? `w${Math.random().toString(36).slice(2)}`;
let listening: Promise<unknown> | null = null;

const emit = (on: boolean) => {
  if (!isTauri()) return;
  void import('@tauri-apps/api/event')
    .then(({ emit: send }) => send(RECORDING_EVENT, { on, source: WINDOW_ID }))
    .catch((err: unknown) => console.error('[shortcut] emit recording failed:', err));
};

/** True while any recorder (this window or another) is recording. */
export function isDictationSuspended(now = Date.now()): boolean {
  if (localCount > 0) return true;
  for (const [source, until] of remote) {
    if (now < until) return true;
    remote.delete(source);
  }
  return false;
}

/** Apply a lease event: one window's 'off' only ends that window's lease. */
export function applyRemoteLease(payload: { on: boolean; source?: string }, now = Date.now()): void {
  const source = payload.source ?? 'unknown';
  if (source === WINDOW_ID) return; // our own lease is localCount
  if (payload.on) remote.set(source, now + LEASE_MS);
  else remote.delete(source);
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
    .then(({ listen }) => listen<{ on: boolean; source?: string }>(RECORDING_EVENT, (e) => applyRemoteLease(e.payload)))
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
  remote.clear();
  listening = null;
}
