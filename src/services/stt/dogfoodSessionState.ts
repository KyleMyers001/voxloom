/// Mutable bookkeeping shared by the dogfood capture lifecycle and post-stop
/// processing. Kept outside React state: async steps must read the latest
/// values across awaits.

import { useRef } from 'react';
import type { CaptureState } from '../capture/types';
import type { CancelScope } from '../shortcut/cancelScope';

/** Per-session lease: cancellation discards results, unlike supersession. */
export interface Cancellation {
  cancelled: boolean;
  scope?: CancelScope;
  settle?: () => Promise<void>;
}

export interface DogfoodLiveSession {
  /**
   * Bumped by start/cancel. A prior session's STT/delivery may still be in
   * flight when the next hold starts; retain its transcript in history but
   * suppress new delivery side effects and preserve the newer session's phase.
   */
  session: number;
  /**
   * The session whose start requested the current capture. Its terminal
   * capture state must not end a newer session that is still live.
   */
  captureSession: number | null;
  /** That session's cancellation: its late stop is processed under it. */
  captureCancellation: Cancellation | null;
  /** Escape cancels only while a session is active. */
  active: boolean;
  cancellation: Cancellation;
  /**
   * A replacement must not destroy the native latch before its result is
   * saved. Carry the retirement barrier through even a second pending restart.
   */
  retirement: Promise<void> | undefined;
  /** The latest cancel(), for native-latch callbacks that outlive a render. */
  cancelAction: () => void;
  /** Aborts the latest run's cleanup on cancel or when a new start supersedes it. */
  processing: AbortController | null;
  /** Set by stop/cancel so a finish that races start still terminates. */
  stopRequested: boolean;
  /** Stopped audio already handed to processing. */
  handledAudioId: string | null;
}

/** One stable object for the hook's lifetime. */
export function useDogfoodLiveSession(): DogfoodLiveSession {
  return useRef<DogfoodLiveSession>({
    active: false,
    cancelAction: () => {},
    cancellation: { cancelled: false },
    captureCancellation: null,
    captureSession: null,
    handledAudioId: null,
    processing: null,
    retirement: undefined,
    session: 0,
    stopRequested: false,
  }).current;
}

/**
 * Retire a replaced session's Escape scope before its stop reached
 * processing. A late stop is still processed under that session, so keep the
 * native latch's answer instead of discarding it: a queued Escape cancels the
 * session; otherwise it needs no scope. Undefined when there is no scope.
 */
export function retireScope(cancellation: Cancellation): Promise<void> | undefined {
  const scope = cancellation.scope;
  if (!scope) return undefined;
  if (cancellation.cancelled) return scope.dispose().catch(() => {});
  return (async () => {
    let accepted = false;
    try { accepted = await scope.finish(); } catch { /* fail closed */ }
    if (!accepted) cancellation.cancelled = true;
    if (cancellation.scope === scope) cancellation.scope = undefined;
  })();
}

/**
 * Whether a capture state is an older capture's and must be ignored. Its
 * cancel/error (the event that released the mic for a restart) must not end
 * a newer live session, and its stop without audio (quick tap, then re-hold
 * or cancel) is never the current session's. Its stop with audio is still
 * processed, under its own session (`captureSession`).
 */
export function isStaleCaptureEvent(state: CaptureState, live: DogfoodLiveSession): boolean {
  if (live.captureSession === live.session) return false;
  if (state.kind === 'cancelled' || state.kind === 'error') return live.active;
  return state.kind === 'stopped' && !state.audio;
}
