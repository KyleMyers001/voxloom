/// Dogfood capture session lifecycle: start, stop, cancel, supersession, and
/// the Escape cancel scope. start() must not activate Voxloom; gesture
/// callers rely on the other app still being frontmost.

import { useCallback, useEffect, useRef } from 'react';
import { SYSTEM_DEFAULT_DEVICE_ID } from '../capture/types';
import type { UseCaptureStateResult } from '../capture/useCaptureState';
import { beginCancelScope } from '../shortcut/cancelScope';
import { useCancelUnavailable, type CancelUnavailable } from '../shortcut/cancelUnavailable';
import { errorText } from './dogfoodModel';
import type { DogfoodOrigin, DogfoodPhase, DogfoodViewActions } from './dogfoodPhase';
import { afterListening, endWithoutListening } from './dogfoodNotice';
import { beginSession, ownedBy, type DogfoodLiveSession } from './dogfoodSessionState';

/** The older capture never released the mic; it was cancelled instead. */
export const RELEASE_TIMEOUT = 'The previous dictation did not stop in time. Try again.';

export interface DogfoodSessionInput {
  actions: DogfoodViewActions;
  capture: UseCaptureStateResult;
  /** Disposes the native cleanup engine on unmount. */
  disposeNativeEngine: () => void;
  /** Resolves the selected model id or throws `model-missing`. */
  ensureModel: () => Promise<string>;
  live: DogfoodLiveSession;
  phase: DogfoodPhase;
  preferredDeviceId?: string;
}

export interface DogfoodSessionControls {
  cancel: () => void;
  /** Escape-cancel could not arm this app run; dictation still works. */
  cancelUnavailable: CancelUnavailable | null;
  start: (origin?: DogfoodOrigin) => Promise<void>;
  stop: () => Promise<void>;
}

export function useDogfoodSession({
  actions, capture, disposeNativeEngine, ensureModel, live, phase, preferredDeviceId,
}: DogfoodSessionInput): DogfoodSessionControls {
  const captureRef = useRef(capture);
  captureRef.current = capture;
  const {
    announce, announceError, setHudReady, setHudResult, setIntendedTarget, setMessage,
    setOrigin, setPhase, setScopeReady, setTranscript, toast,
  } = actions;
  const {
    clear: clearCancelUnavailable, notice: cancelNotice, report: reportCancelUnavailable,
    takeHint: takeCancelHint,
  } = useCancelUnavailable();

  /** End as cancelled: by the user (drops a held notice) or by a release. */
  const endCancelled = useCallback((how: 'cancelled' | 'released') => {
    setPhase('cancelled');
    setMessage('Capture cancelled — nothing transcribed.');
    endWithoutListening(live, how, actions);
  }, [actions, live]);

  const start = useCallback(async (source: DogfoodOrigin = 'home') => {
    // A superseded run is never delivered; stop its cleanup so the worker is
    // free. It falls back to raw text and still reaches History.
    live.processing?.abort();
    const { cancellation, retirement, session } = beginSession(live);
    setScopeReady(false);
    setHudReady(false);
    setPhase('starting');
    setOrigin(source);
    const superseded = () => session !== live.session;
    setTranscript(null);
    setHudResult(null);
    setMessage(null);
    setIntendedTarget(null);
    const fail = (error: string) => {
      setPhase('error');
      endWithoutListening(live, { error }, actions);
    };

    try {
      if (retirement) await retirement;
      if (superseded()) return;
      // An older capture (a quick tap still stopping) owns the mic until its
      // terminal event. Wait before arming Escape so no cancel can reach it.
      if (await capture.waitForCaptureRelease() === false) throw new Error(RELEASE_TIMEOUT);
      if (superseded()) return;
      try {
        cancellation.scope = await beginCancelScope(() => {
          cancellation.cancelled = true;
          if (session === live.session) live.cancelAction();
        }, () => !superseded() && !cancellation.cancelled);
      } catch (error: unknown) {
        // Escape-cancel is optional: a tap failure must never block dictation.
        // A superseded attempt's failure must not replace the newer report.
        if (!superseded()) reportCancelUnavailable(error);
      }
      if (superseded()) {
        await cancellation.scope?.dispose();
        return;
      }
      if (cancellation.scope) { clearCancelUnavailable(); setScopeReady(true); }
      // Show the HUD (waveform) even when Escape-cancel could not arm.
      setHudReady(true);
      await ensureModel();
    } catch (error: unknown) {
      if (!superseded()) fail(errorText(error));
      return;
    }
    if (superseded()) return;

    // Released during the wait or model validation: never open the mic.
    if (live.stopRequested) return endCancelled('released');
    const deviceId = preferredDeviceId === SYSTEM_DEFAULT_DEVICE_ID ? undefined : preferredDeviceId || undefined;

    try {
      const owner = live.captureOwner = { cancellation, session };
      const started = await capture.startFullCaptureSession(deviceId, owner);
      if (superseded() || started === 'ended') return;
      if (started !== 'started') {
        fail(started === 'busy'
          ? 'A capture session is already active. Wait for it to finish.'
          : 'Microphone capture could not start. Check permission and retry.');
        return;
      }
      setPhase('recording');
      announce('Listening…');
      afterListening(live, takeCancelHint(), toast);
      if (live.stopRequested) await capture.stopFullCapture();
    } catch (error: unknown) {
      if (!superseded()) fail(errorText(error));
    }
  }, [
    actions, capture, clearCancelUnavailable, endCancelled, ensureModel, live, preferredDeviceId,
    reportCancelUnavailable, takeCancelHint,
  ]);

  const stop = useCallback(async () => {
    const session = live.session;
    live.stopRequested = true;
    try {
      // Only its own capture: an older one still stopping keeps its audio.
      await capture.stopFullCapture(ownedBy(live.cancellation));
    } catch (error: unknown) {
      if (session !== live.session) return;
      setPhase('error');
      announceError(errorText(error));
    }
  }, [actions, capture, live]);

  const cancel = useCallback(() => {
    live.active = false;
    setScopeReady(false);
    setHudReady(false);
    live.cancellation.cancelled = true;
    // After `cancelled` is set, so the cleanup stage reports a user cancel.
    live.processing?.abort();
    void live.cancellation.scope?.dispose().catch(() => {});
    live.session += 1;
    live.stopRequested = true;
    live.handledAudioId = null;
    setIntendedTarget(null);
    try {
      // Only its own capture: an older one still stopping keeps its audio.
      capture.cancelActiveCapture(ownedBy(live.cancellation));
    } finally {
      endCancelled('cancelled');
    }
  }, [actions, capture, endCancelled, live]);

  live.cancelAction = cancel;

  useEffect(() => () => {
    live.active = false;
    live.cancellation.cancelled = true;
    live.processing?.abort();
    disposeNativeEngine();
    live.session += 1;
    void live.cancellation.scope?.dispose().catch(() => {});
    captureRef.current.cancelActiveCapture();
  }, [disposeNativeEngine, live]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !live.active) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [cancel, live]);

  useEffect(() => {
    if (phase === 'success' || phase === 'error' || phase === 'cancelled') {
      live.active = false;
      void live.cancellation.scope?.dispose().catch(() => {});
    }
  }, [live, phase]);

  return { cancel, cancelUnavailable: cancelNotice, start, stop };
}
