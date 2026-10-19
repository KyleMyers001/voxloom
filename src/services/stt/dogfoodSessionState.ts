/// Mutable bookkeeping shared by the dogfood capture lifecycle and post-stop
/// processing. Kept outside React state: async steps must read the latest
/// values across awaits.

import { useRef } from 'react';
import type { CaptureState } from '../capture/types';
import type { CancelScope } from '../shortcut/cancelScope';

/** Per-session lease: cancellation discards results, unlike supersession. */
export interface Cancellation {
  cancelled: boolean;
  /** Set while a replacement retires this scope; settling waits for it. */
  retired?: Promise<void>;
  scope?: CancelScope;
  settle?: () => Promise<void>;
}

/** The session that requested a capture; echoed on its stopped state. */
export interface CaptureOwner {
  cancellation: Cancellation;
  session: number;
}

export interface DogfoodLiveSession {
  /**
   * Bumped by start/cancel. A prior session's STT/delivery may still be in
   * flight when the next hold starts; retain its transcript in history but
   * suppress new delivery side effects and preserve the newer session's phase.
   */
  session: number;
  /**
   * The session whose start requested the latest capture. Its terminal
   * capture state must not end a newer session that is still live.
   */
  captureOwner: CaptureOwner | null;
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
  /** The live session has announced "Listening…". */
  listening: boolean;
  /** A notice held until the starting session's "Listening…" has shown. */
  pendingNotice: string | null;
}

/** One stable object for the hook's lifetime. */
export function useDogfoodLiveSession(): DogfoodLiveSession {
  return useRef<DogfoodLiveSession>({
    active: false,
    cancelAction: () => {},
    cancellation: { cancelled: false },
    captureOwner: null,
    handledAudioId: null,
    listening: false,
    pendingNotice: null,
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
 * session; otherwise it needs no scope. The scope is detached first and
 * settling waits on `retired`, so it is never finished twice.
 */
export function retireScope(cancellation: Cancellation): Promise<void> | undefined {
  const scope = cancellation.scope;
  if (!scope) return undefined;
  if (cancellation.cancelled) return scope.dispose().catch(() => {});
  cancellation.scope = undefined;
  cancellation.retired = (async () => {
    let accepted = false;
    try { accepted = await scope.finish(); } catch { /* fail closed */ }
    if (!accepted) cancellation.cancelled = true;
  })();
  return cancellation.retired;
}

/**
 * Start a new session: retire the previous one's scope (or settle it) behind
 * a barrier the new capture waits for, and reset per-session flags.
 */
export function beginSession(live: DogfoodLiveSession) {
  const session = ++live.session;
  const previous = live.cancellation;
  const retire = previous.settle?.() ?? retireScope(previous);
  const retirement = retire || live.retirement
    ? Promise.all([live.retirement, retire]).then(() => {})
    : undefined;
  const cancellation: Cancellation = { cancelled: false };
  // A held notice carries over: it shows after this session's "Listening…".
  Object.assign(live, {
    active: true, cancellation, handledAudioId: null, listening: false, retirement,
    stopRequested: false,
  });
  return { cancellation, retirement, session };
}

/** The owner of a capture state: its echoed token, else the latest capture's. */
export function ownerOf(state: CaptureState, live: DogfoodLiveSession): CaptureOwner | null {
  const echoed = state.kind === 'stopped' ? state.owner as CaptureOwner | undefined : undefined;
  return echoed ?? live.captureOwner;
}

/**
 * Whether a capture state is an older capture's and must be ignored. Its
 * cancel/error (the event that released the mic for a restart) must not end
 * a newer live session, and its stop without audio (quick tap, then re-hold
 * or cancel) is never the current session's. Its stop with audio is still
 * processed, under its own session.
 */
export function isStaleCaptureEvent(state: CaptureState, live: DogfoodLiveSession): boolean {
  if ((ownerOf(state, live)?.session ?? null) === live.session) return false;
  if (state.kind === 'cancelled' || state.kind === 'error') return live.active;
  return state.kind === 'stopped' && !state.audio;
}

/** Toast `text` now, or hold it until the starting session's "Listening…". */
export function showNotice(live: DogfoodLiveSession, text: string, toast: (text: string) => void) {
  if (live.active && !live.listening) live.pendingNotice = text;
  else toast(text);
}

/** Whether a capture's owner token is `cancellation`'s session. */
export function ownedBy(cancellation: Cancellation) {
  return (owner: unknown) => (owner as CaptureOwner | undefined)?.cancellation === cancellation;
}

/** `text` with any held notice appended (and no longer held). */
export function withNotice(live: DogfoodLiveSession, text: string | null): string {
  const shown = [text, live.pendingNotice].filter(Boolean).join(' ');
  live.pendingNotice = null;
  return shown;
}

/** After "Listening…": show a held notice and/or the Escape-cancel hint. */
export function afterListening(live: DogfoodLiveSession, hint: string | null, toast: (text: string) => void) {
  live.listening = true;
  const shown = withNotice(live, hint);
  if (shown) toast(shown);
}
