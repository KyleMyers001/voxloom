/// Mutable bookkeeping shared by the dogfood capture lifecycle and post-stop
/// processing. Kept outside React state: async steps must read the latest
/// values across awaits.

import { useRef } from 'react';
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
    handledAudioId: null,
    processing: null,
    retirement: undefined,
    session: 0,
    stopRequested: false,
  }).current;
}
