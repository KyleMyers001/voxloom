/// Wire full capture stop → dogfoodTranscribeAndCopy on the main UI.
/// Automatic STT + delivery after a clean stop; cancel discards with no STT.
/// Snapshots intended target after final transcription (ADR §4).
/// Shared by Home Start and global hold/latch — start() must not activate
/// Voxloom; gesture callers rely on the other app still being frontmost.
/// Never silent-downloads missing models — surfaces a clear UI error instead.

import { useCallback, useEffect, useRef, useState } from 'react';
import { beginCancelScope, type CancelScope } from '../shortcut/cancelScope';
import type { DeliveryOutcome } from '../delivery/types';
import type { OverlayResult } from '../shortcut/overlayVisibility';

import { createDogfoodRecord } from '../../domain/records';
import type { DictationRecord, WritingStyle } from '../../domain/types';
import type { ClipboardAdapter } from '../clipboard';
import {
  createStubDeliveryAdapter,
  createTauriDeliveryAdapter,
  type DeliveryPlatformAdapter,
  type TargetSnapshot,
} from '../delivery';
import {
  SYSTEM_DEFAULT_DEVICE_ID,
  type CaptureState,
} from '../capture/types';
import {
  useCaptureState,
  type UseCaptureStateResult,
} from '../capture/useCaptureState';
import type { SttModelStore } from './contracts';
import {
  dogfoodTranscribeAndCopy,
  type CaptureAudioMeta,
} from './dogfoodPath';
import { createSttModelStore } from './factory';
import { resolveTranscriptionModelId } from './resolveModelId';
import { SttError, type Transcript } from './types';

export type DogfoodPhase =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'transcribing'
  | 'success'
  | 'error'
  | 'cancelled';

export interface UseDogfoodCaptureOptions {
  clipboard: ClipboardAdapter;
  /** Settings `clipboardFallback` (default true). */
  clipboardFallback?: boolean;
  /** Settings `transcriptionModel` (resolved before STT). */
  modelId: string;
  /** Clock for history `createdAt` (defaults to Date.now). */
  now?: () => number;
  /**
   * Session History append after a non-blank dogfood transcript.
   * Cancel / blank audio / STT errors never call this.
   */
  onHistoryRecord?: (record: DictationRecord) => void;
  /** Toast / announce callback for loading / success / error. */
  onToast?: (message: string) => void;
  /** Preferred mic id; system default means omit and let native pick. */
  preferredDeviceId?: string;
  /** Writing style stamped onto the history row. */
  style?: WritingStyle;
  /** Test seam: inject capture API instead of the live hook result. */
  captureApi?: UseCaptureStateResult;
  /** Test seam: model store (status checks; never download). */
  createModelStore?: () => SttModelStore;
  /** Test seam: dogfood path. */
  dogfood?: typeof dogfoodTranscribeAndCopy;
  /** Test seam: delivery platform (snapshot / insert / clipboard). */
  deliveryPlatform?: DeliveryPlatformAdapter;
}

export interface UseDogfoodCaptureResult {
  cancel: () => void;
  captureState: CaptureState;
  /** Completion-time target (null until final transcription / if unavailable). */
  intendedTarget: TargetSnapshot | null;
  /** HUD result of the last run: Copied / Couldn't insert / Couldn't transcribe; null shows nothing. */
  hudResult: OverlayResult | null;
  message: string | null;
  origin: 'home' | 'gesture' | null;
  phase: DogfoodPhase;
  /** Current session has acquired its cancellation scope; popup may show. */
  scopeReady: boolean;
  start: (origin?: 'home' | 'gesture') => Promise<void>;
  stop: () => Promise<void>;
  transcript: Transcript | null;
}

/**
 * HUD rules 3–6: only Copied (or maybe-copied) and a definite failure show
 * anything after delivery. Unverified and "may have been inserted, nothing
 * copied" dismiss silently like a success; History keeps the
 * Unverified badge.
 */
export function hudResultFor(
  { mayHaveInserted = false, status }: Pick<DeliveryOutcome, 'mayHaveInserted' | 'status'>,
): OverlayResult | null {
  if (status === 'copied') return mayHaveInserted ? 'maybe-copied' : 'copied';
  if (status === 'failed') return mayHaveInserted ? null : 'insert-failed';
  return null; // inserted, unverified, or may-have-inserted: silent dismiss
}

function errorText(error: unknown): string {
  if (error instanceof SttError) {
    if (error.code === 'model-missing') {
      // Settings guidance lives here once; missingModelMessage is the fact only.
      return `${error.message} Download the selected model in Settings first.`;
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function missingModelMessage(modelId: string, status: string | null): string {
  const detail = status ? ` (status: ${status})` : '';
  // Fact only — errorText appends the short Settings suffix once.
  return `Model “${modelId}” is not downloaded${detail}.`;
}

function resolvePlatform(
  clipboard: ClipboardAdapter,
  injected?: DeliveryPlatformAdapter,
): DeliveryPlatformAdapter {
  if (injected) return injected;
  try {
    return createTauriDeliveryAdapter(clipboard);
  } catch {
    return createStubDeliveryAdapter({ clipboard });
  }
}

export function useDogfoodCapture(
  options: UseDogfoodCaptureOptions,
): UseDogfoodCaptureResult {
  const liveCapture = useCaptureState();
  const capture = options.captureApi ?? liveCapture;
  const captureRef = useRef(capture);
  captureRef.current = capture;

  const [phase, setPhase] = useState<DogfoodPhase>('idle');
  const [scopeReady, setScopeReady] = useState(false);
  const [hudResult, setHudResult] = useState<OverlayResult | null>(null);
  const [origin, setOrigin] = useState<'home' | 'gesture' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [intendedTarget, setIntendedTarget] =
    useState<TargetSnapshot | null>(null);

  const dogfoodRef = useRef(options.dogfood ?? dogfoodTranscribeAndCopy);
  dogfoodRef.current = options.dogfood ?? dogfoodTranscribeAndCopy;
  const storeRef = useRef(
    (options.createModelStore ?? createSttModelStore)(),
  );
  if (options.createModelStore) {
    storeRef.current = options.createModelStore();
  }

  const modelIdRef = useRef(options.modelId);
  modelIdRef.current = options.modelId;
  const clipboardRef = useRef(options.clipboard);
  clipboardRef.current = options.clipboard;
  const clipboardFallbackRef = useRef(options.clipboardFallback !== false);
  clipboardFallbackRef.current = options.clipboardFallback !== false;
  const toastRef = useRef(options.onToast);
  toastRef.current = options.onToast;
  const historyRef = useRef(options.onHistoryRecord);
  historyRef.current = options.onHistoryRecord;
  const styleRef = useRef(options.style ?? 'formal');
  styleRef.current = options.style ?? 'formal';
  const nowRef = useRef(options.now ?? Date.now);
  nowRef.current = options.now ?? Date.now;
  const platformRef = useRef<DeliveryPlatformAdapter>(
    resolvePlatform(options.clipboard, options.deliveryPlatform),
  );
  platformRef.current = resolvePlatform(
    options.clipboard,
    options.deliveryPlatform,
  );
  /** Set by stop/cancel so a finish that races start still terminates. */
  const stopRequestedRef = useRef(false);
  /**
   * Bumped by start/cancel. A prior session's STT/delivery may still be in
   * flight when the next hold starts; retain its transcript in history but
   * suppress new delivery side effects and preserve the newer session's phase.
   */
  const sessionRef = useRef(0);
  const activeRef = useRef(false);
  // Per-session lease: cancellation discards results, unlike supersession.
  type Cancellation = { cancelled: boolean; scope?: CancelScope; settle?: () => Promise<void> };
  const cancellationRef = useRef<Cancellation>({ cancelled: false });
  // A replacement must not destroy the native latch before its result is saved.
  // Carry the retirement barrier through even a second pending restart.
  const retirementRef = useRef<Promise<void> | undefined>(undefined);
  const cancelActionRef = useRef<() => void>(() => {});

  const announce = useCallback((text: string) => {
    setMessage(text);
    toastRef.current?.(text);
  }, []);

  const ensureModelAvailable = useCallback(async (rawModelId: string) => {
    const modelId = resolveTranscriptionModelId(rawModelId);
    const info = await storeRef.current.status(modelId);
    if (!info || info.status !== 'available') {
      throw new SttError(
        'model-missing',
        missingModelMessage(modelId, info?.status ?? null),
      );
    }
    return modelId;
  }, []);

  const runDogfood = useCallback(async (audio: CaptureAudioMeta) => {
    const session = sessionRef.current;
    const cancellation = cancellationRef.current;
    const current = () => session === sessionRef.current && !cancellation.cancelled;
    const platform = platformRef.current;
    let settlement: Promise<void> | undefined;
    // Both STT success and failure must consult the native latch, whose
    // notification may still be queued. Share the barrier so it runs once.
    const settleCancellation = () => settlement ??= (async () => {
      if (cancellation.cancelled) return;
      const scope = cancellation.scope;
      if (scope) {
        let accepted = false;
        try { accepted = await scope.finish(); } catch { /* fail closed */ }
        if (!accepted) {
          cancellation.cancelled = true;
          if (session === sessionRef.current) cancelActionRef.current();
          return;
        }
      }
      if (current()) activeRef.current = false;
    })();
    cancellation.settle = settleCancellation;
    setPhase('transcribing');
    announce('Transcribing…');
    try {
      const modelId = await ensureModelAvailable(modelIdRef.current);
      if (cancellation.cancelled) return;
      const result = await dogfoodRef.current({
        audio,
        clipboard: clipboardRef.current,
        clipboardFallback: clipboardFallbackRef.current,
        deliveryPlatform: platform,
        isCurrent: current,
        beforeDelivery: settleCancellation,
        snapshotTarget: async () => {
          const target = await platform.snapshotTarget();
          if (current()) setIntendedTarget(target);
          return target;
        },
        modelId,
      });
      // A stale successful path skips beforeDelivery, but still needs the
      // saved cancellation decision before publishing History or a toast.
      await settleCancellation();
      if (cancellation.cancelled) return;
      if (current()) {
        setTranscript(result.transcript);
        setHudResult(hudResultFor(result.delivery));
        setPhase('success');
      }
      const record = createDogfoodRecord({
        durationMs: audio.duration_ms,
        id: `dogfood-${audio.id}`,
        mayHaveInserted: result.delivery.mayHaveInserted,
        model: modelId,
        now: nowRef.current(),
        rawText: result.transcript.rawText,
        status: result.delivery.status,
        style: styleRef.current,
        text: result.transcript.text,
      });
      if (record) {
        historyRef.current?.(record);
      }
      // Stale session: evidence still surfaces as a toast, phase untouched.
      if (current()) announce(result.delivery.message);
      else toastRef.current?.(result.delivery.message);
    } catch (error: unknown) {
      await settleCancellation();
      if (cancellation.cancelled) return;
      if (current()) {
        setHudResult('transcribe-failed');
        setPhase('error');
        announce(errorText(error));
      } else {
        toastRef.current?.(errorText(error));
      }
    } finally {
      await cancellation.scope?.dispose().catch(() => {});
    }
  }, [announce, ensureModelAvailable]);

  // Auto dogfood on clean stop (user stop or 120s/capacity bound).
  // Automatic bounds use the same completion-time target policy.
  const handledAudioIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (capture.captureState.kind === 'cancelled') {
      setPhase('cancelled');
      setMessage('Capture cancelled — nothing transcribed.');
      return;
    }
    if (capture.captureState.kind === 'error') {
      setPhase('error');
      setMessage(capture.captureState.message);
      return;
    }
    if (capture.captureState.kind !== 'stopped') return;
    const audio = capture.captureState.audio;
    if (!audio) {
      setPhase('error');
      announce('Capture stopped without audio — nothing to transcribe.');
      return;
    }
    if (handledAudioIdRef.current === audio.id) return;
    handledAudioIdRef.current = audio.id;
    void runDogfood(audio);
  }, [announce, capture.captureState, runDogfood]);

  const start = useCallback(async (source: 'home' | 'gesture' = 'home') => {
    const session = ++sessionRef.current;
    const previous = cancellationRef.current;
    const retire = previous.settle?.() ?? previous.scope?.dispose().catch(() => {});
    const retirement = retire || retirementRef.current
      ? Promise.all([retirementRef.current, retire]).then(() => {})
      : undefined;
    retirementRef.current = retirement;
    const cancellation: Cancellation = { cancelled: false };
    cancellationRef.current = cancellation;
    activeRef.current = true;
    setScopeReady(false);
    setPhase('starting');
    setOrigin(source);
    const superseded = () => session !== sessionRef.current;
    setTranscript(null);
    setHudResult(null);
    setMessage(null);
    handledAudioIdRef.current = null;
    stopRequestedRef.current = false;
    setIntendedTarget(null);

    try {
      if (retirement) await retirement;
      if (superseded()) return;
      cancellation.scope = await beginCancelScope(() => {
        cancellation.cancelled = true;
        if (session === sessionRef.current) cancelActionRef.current();
      }, () => !superseded() && !cancellation.cancelled);
      if (superseded()) {
        await cancellation.scope.dispose();
        return;
      }
      setScopeReady(true);
      await ensureModelAvailable(modelIdRef.current);
    } catch (error: unknown) {
      if (superseded()) return;
      setPhase('error');
      announce(errorText(error));
      return;
    }
    if (superseded()) return;

    // Hold release may have already requested stop during model validation.
    if (stopRequestedRef.current) {
      setPhase('cancelled');
      setMessage('Capture cancelled — nothing transcribed.');
      return;
    }

    const deviceId = options.preferredDeviceId
      && options.preferredDeviceId !== SYSTEM_DEFAULT_DEVICE_ID
      ? options.preferredDeviceId
      : undefined;

    try {
      const started = await capture.startFullCaptureSession(deviceId);
      if (superseded() || started === 'ended') return;
      if (started !== 'started') {
        setPhase('error');
        announce(started === 'busy'
          ? 'A capture session is already active. Wait for it to finish.'
          : 'Microphone capture could not start. Check permission and retry.');
        return;
      }
      setPhase('recording');
      announce('Listening…');
      if (stopRequestedRef.current) await capture.stopFullCapture();
    } catch (error: unknown) {
      if (superseded()) return;
      setPhase('error');
      announce(errorText(error));
    }
  }, [
    announce,
    capture,
    ensureModelAvailable,
    options.preferredDeviceId,
  ]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    stopRequestedRef.current = true;
    try {
      await capture.stopFullCapture();
    } catch (error: unknown) {
      if (session !== sessionRef.current) return;
      setPhase('error');
      announce(errorText(error));
    }
  }, [announce, capture]);

  const cancel = useCallback(() => {
    activeRef.current = false;
    setScopeReady(false);
    cancellationRef.current.cancelled = true;
    void cancellationRef.current.scope?.dispose().catch(() => {});
    sessionRef.current += 1;
    stopRequestedRef.current = true;
    handledAudioIdRef.current = null;
    setIntendedTarget(null);
    try {
      capture.cancelActiveCapture();
    } finally {
      setPhase('cancelled');
      setMessage('Capture cancelled — nothing transcribed.');
    }
  }, [capture]);

  cancelActionRef.current = cancel;

  useEffect(() => () => {
    activeRef.current = false;
    cancellationRef.current.cancelled = true;
    sessionRef.current += 1;
    void cancellationRef.current.scope?.dispose().catch(() => {});
    captureRef.current.cancelActiveCapture();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !activeRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [cancel]);

  useEffect(() => {
    if (phase === 'success' || phase === 'error' || phase === 'cancelled') {
      activeRef.current = false;
      void cancellationRef.current.scope?.dispose().catch(() => {});
    }
  }, [phase]);

  return {
    cancel,
    captureState: capture.captureState,
    intendedTarget,
    message,
    origin,
    hudResult,
    phase,
    scopeReady: scopeReady && (phase === 'starting' || phase === 'recording' || phase === 'transcribing'),
    start,
    stop,
    transcript,
  };
}

