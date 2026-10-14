/**
 * BUS-69: keep the global hotkey unbound for as long as any shortcut
 * recorder records, and re-bind it the moment recording ends (save,
 * cancel, blur, unmount, or a remote lease lapsing).
 *
 * Why: macOS RegisterEventHotKey consumes the keystroke system-wide,
 * including in our own webview, so re-recording the current shortcut
 * never reached the recorder's keydown listener.
 */
import type { Scheduler } from '../contracts';
import { isDictationSuspended, onSuspendChange } from './recordingSuspend';

/** How often to re-check while suspended (remote leases lapse silently). */
export const UNBIND_RECHECK_MS = 1_000;

export interface UnbindDeps {
  isSuspended?: () => boolean;
  scheduler: Scheduler;
  subscribe?: (watcher: () => void) => () => void;
}

export function unbindWhileRecording(
  controller: { suspendBinding(on: boolean): Promise<void> },
  { isSuspended = isDictationSuspended, scheduler, subscribe = onSuspendChange }: UnbindDeps,
): () => void {
  let unbound = false;
  let timer: number | null = null;
  let stopped = false;

  const sync = () => {
    if (stopped) return;
    const on = isSuspended();
    if (timer !== null) { scheduler.clear(timer); timer = null; }
    if (on) timer = scheduler.set(sync, UNBIND_RECHECK_MS);
    if (on === unbound) return;
    unbound = on;
    void controller.suspendBinding(on).catch(() => undefined);
  };

  const unsubscribe = subscribe(sync);
  sync();
  return () => {
    stopped = true;
    unsubscribe();
    if (timer !== null) scheduler.clear(timer);
    if (unbound) void controller.suspendBinding(false).catch(() => undefined);
  };
}
