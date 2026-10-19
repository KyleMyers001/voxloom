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
import type { Cancellation, DogfoodLiveSession } from './dogfoodSessionState';

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

  const start = useCallback(async (source: DogfoodOrigin = 'home') => {
    // A superseded run is never delivered; stop its cleanup so the worker is
    // free. It falls back to raw text and still reaches History.
    live.processing?.abort();
    const session = ++live.session;
    const previous = live.cancellation;
    const retire = previous.settle?.() ?? previous.scope?.dispose().catch(() => {});
    const retirement = retire || live.retirement
      ? Promise.all([live.retirement, retire]).then(() => {})
      : undefined;
    live.retirement = retirement;
    const cancellation: Cancellation = { cancelled: false };
    live.cancellation = cancellation;
    live.active = true;
    setScopeReady(false);
    setHudReady(false);
    setPhase('starting');
    setOrigin(source);
    const superseded = () => session !== live.session;
    setTranscript(null);
    setHudResult(null);
    setMessage(null);
    live.handledAudioId = null;
    live.stopRequested = false;
    setIntendedTarget(null);

    try {
      if (retirement) await retirement;
      if (superseded()) return;
      try {
        cancellation.scope = await beginCancelScope(() => {
          cancellation.cancelled = true;
          if (session === live.session) live.cancelAction();
        }, () => !superseded() && !cancellation.cancelled);
      } catch (error: unknown) {
        // Escape-cancel is optional: a tap failure must never block dictation.
        reportCancelUnavailable(error);
      }
      if (superseded()) {
        await cancellation.scope?.dispose();
        return;
      }
      if (cancellation.scope) {
        clearCancelUnavailable();
        setScopeReady(true);
      }
      // Show the HUD (waveform) even when Escape-cancel could not arm.
      setHudReady(true);
      await ensureModel();
    } catch (error: unknown) {
      if (superseded()) return;
      setPhase('error');
      announceError(errorText(error));
      return;
    }
    if (superseded()) return;

    // Hold release may have already requested stop during model validation.
    if (live.stopRequested) {
      setPhase('cancelled');
      setMessage('Capture cancelled — nothing transcribed.');
      return;
    }

    const deviceId = preferredDeviceId
      && preferredDeviceId !== SYSTEM_DEFAULT_DEVICE_ID
      ? preferredDeviceId
      : undefined;

    try {
      // A just-cancelled capture still owns the mic until its terminal event.
      await capture.waitForCaptureRelease();
      if (superseded()) return;
      live.captureSession = session;
      const started = await capture.startFullCaptureSession(deviceId);
      if (superseded() || started === 'ended') return;
      if (started !== 'started') {
        setPhase('error');
        announceError(started === 'busy'
          ? 'A capture session is already active. Wait for it to finish.'
          : 'Microphone capture could not start. Check permission and retry.');
        return;
      }
      setPhase('recording');
      announce('Listening…');
      const hint = takeCancelHint();
      if (hint) toast(hint);
      if (live.stopRequested) await capture.stopFullCapture();
    } catch (error: unknown) {
      if (superseded()) return;
      setPhase('error');
      announceError(errorText(error));
    }
  }, [
    actions, capture, clearCancelUnavailable, ensureModel, live, preferredDeviceId,
    reportCancelUnavailable, takeCancelHint,
  ]);

  const stop = useCallback(async () => {
    const session = live.session;
    live.stopRequested = true;
    try {
      await capture.stopFullCapture();
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
      capture.cancelActiveCapture();
    } finally {
      setPhase('cancelled');
      setMessage('Capture cancelled — nothing transcribed.');
    }
  }, [actions, capture, live]);

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
