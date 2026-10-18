/// Capture stop → STT → optional cleanup → completion-time target → delivery.
/// Home and global gestures share this path; starting never activates an app.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createDogfoodRecord } from '../../domain/records';
import type { DictationRecord, WritingStyle } from '../../domain/types';
import type { ClipboardAdapter } from '../clipboard';
import {
  CleanupEngineError,
  createCleanupProvenance,
  createTauriCleanupEngine,
  snapshotDictionary,
  type CleanupEngine,
  type CleanupSnapshot,
} from '../cleanup';
import {
  DictationCoordinator,
  type ProcessingReservation,
} from '../dictation/coordinator';
import {
  createStubDeliveryAdapter,
  createTauriDeliveryAdapter,
  type DeliveryOutcome,
  type DeliveryPlatformAdapter,
  type TargetSnapshot,
} from '../delivery';
import { beginCancelScope, type CancelScope } from '../shortcut/cancelScope';
import type { OverlayResult } from '../shortcut/overlayVisibility';
import { SYSTEM_DEFAULT_DEVICE_ID, type CaptureState } from '../capture/types';
import { useCaptureState, type UseCaptureStateResult } from '../capture/useCaptureState';
import type { SttModelStore } from './contracts';
import { dogfoodTranscribeAndCopy, type CaptureAudioMeta, type DogfoodResult } from './dogfoodPath';
import { createSttModelStore } from './factory';
import { resolveTranscriptionModelId } from './resolveModelId';
import { SttError, type Transcript } from './types';

export type DogfoodPhase =
  | 'idle' | 'starting' | 'recording' | 'queued' | 'transcribing'
  | 'cleaning' | 'delivering' | 'success' | 'error' | 'cancelled';

export interface UseDogfoodCaptureOptions {
  clipboard: ClipboardAdapter;
  clipboardFallback?: boolean;
  cleanupEnabled?: boolean;
  cleanupModelId?: string | null;
  dictionary?: readonly string[];
  modelId: string;
  now?: () => number;
  onHistoryRecord?: (record: DictationRecord) => void;
  onToast?: (message: string) => void;
  preferredDeviceId?: string;
  style?: WritingStyle;
  captureApi?: UseCaptureStateResult;
  createModelStore?: () => SttModelStore;
  createProvenance?: typeof createCleanupProvenance;
  cleanupEngine?: CleanupEngine;
  dogfood?: typeof dogfoodTranscribeAndCopy;
  deliveryPlatform?: DeliveryPlatformAdapter;
}

export interface UseDogfoodCaptureResult {
  cancel: () => void;
  captureState: CaptureState;
  /** Null until final transcription and optional cleanup finish. */
  intendedTarget: TargetSnapshot | null;
  hudResult: OverlayResult | null;
  message: string | null;
  origin: 'home' | 'gesture' | null;
  phase: DogfoodPhase;
  scopeReady: boolean;
  /** Arm attempt settled; a failed arm still permits a non-cancellable HUD. */
  hudReady: boolean;
  start: (origin?: 'home' | 'gesture') => Promise<void>;
  stop: () => Promise<void>;
  transcript: Transcript | null;
}

interface Admission {
  clipboardFallback: boolean;
  cleanup: CleanupSnapshot;
  cleanupError?: CleanupEngineError;
  cleanupEngine: CleanupEngine;
  clipboard: ClipboardAdapter;
  deliveryPlatform: DeliveryPlatformAdapter;
  dogfood: typeof dogfoodTranscribeAndCopy;
  history: ((record: DictationRecord) => void) | undefined;
  modelId: string;
  now: () => number;
  provenance: typeof createCleanupProvenance;
  reservation: ProcessingReservation<DogfoodResult>;
}

interface Cancellation {
  cancelled: boolean;
  scope?: CancelScope;
  settle?: () => Promise<void>;
}

/** Uncertain native writes dismiss silently; History retains the evidence. */
export function hudResultFor(
  { mayHaveInserted = false, status }: Pick<DeliveryOutcome, 'mayHaveInserted' | 'status'>,
): OverlayResult | null {
  if (status === 'copied') return mayHaveInserted ? 'maybe-copied' : 'copied';
  if (status === 'failed') return mayHaveInserted ? null : 'insert-failed';
  return null;
}

function errorText(error: unknown): string {
  if (error instanceof SttError && error.code === 'model-missing') {
    return `${error.message} Download the selected model in Settings first.`;
  }
  return error instanceof Error ? error.message : String(error);
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

async function releaseCleanupLease(admission: Admission): Promise<void> {
  try {
    await admission.cleanupEngine.release?.(admission.reservation.id);
  } catch {
    // A settled job's evidence must survive lease-release failure.
  }
}

function cancelAdmission(admission: Admission): void {
  admission.reservation.cancel();
  void releaseCleanupLease(admission);
}

export function useDogfoodCapture(options: UseDogfoodCaptureOptions): UseDogfoodCaptureResult {
  const liveCapture = useCaptureState();
  const capture = options.captureApi ?? liveCapture;
  const captureRef = useRef(capture);
  captureRef.current = capture;
  const [phase, setPhase] = useState<DogfoodPhase>('idle');
  const [scopeReady, setScopeReady] = useState(false);
  const [hudReady, setHudReady] = useState(false);
  const [hudResult, setHudResult] = useState<OverlayResult | null>(null);
  const [origin, setOrigin] = useState<'home' | 'gesture' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [intendedTarget, setIntendedTarget] = useState<TargetSnapshot | null>(null);
  const coordinatorRef = useRef(new DictationCoordinator<DogfoodResult>(2));
  const admissionRef = useRef<Admission | null>(null);
  const processingRef = useRef<{ admission: Admission; session: number } | null>(null);
  const cleanupEngineRef = useRef(options.cleanupEngine ?? createTauriCleanupEngine());
  const storeRef = useRef((options.createModelStore ?? createSttModelStore)());
  if (options.createModelStore) storeRef.current = options.createModelStore();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const stopRequestedRef = useRef(false);
  const sessionRef = useRef(0);
  const activeRef = useRef(false);
  const cancellationRef = useRef<Cancellation>({ cancelled: false });
  const retirementRef = useRef<Promise<void> | undefined>(undefined);
  const cancelActionRef = useRef<() => void>(() => {});

  useEffect(() => {
    // StrictMode setup must recreate both the native owner and queue.
    const engine = options.cleanupEngine ?? createTauriCleanupEngine();
    const coordinator = new DictationCoordinator<DogfoodResult>(2);
    cleanupEngineRef.current = engine;
    coordinatorRef.current = coordinator;
    return () => {
      sessionRef.current += 1;
      coordinator.dispose();
      if (admissionRef.current) cancelAdmission(admissionRef.current);
      admissionRef.current = null;
      processingRef.current = null;
      void engine.dispose?.().catch(() => {
        console.warn('Cleanup session disposal failed; native lifecycle reclamation remains active.');
      });
    };
  }, [options.cleanupEngine]);

  const announce = useCallback((text: string) => {
    setMessage(text);
    optionsRef.current.onToast?.(text);
  }, []);

  const ensureModelAvailable = useCallback(async (rawModelId: string) => {
    const modelId = resolveTranscriptionModelId(rawModelId);
    const info = await storeRef.current.status(modelId);
    if (!info || info.status !== 'available') {
      const detail = info?.status ? ` (status: ${info.status})` : '';
      throw new SttError('model-missing', `Model “${modelId}” is not downloaded${detail}.`);
    }
    return modelId;
  }, []);

  const reserveAdmission = useCallback((): Admission | null => {
    const reservation = coordinatorRef.current.reserve();
    if (!reservation) return null;
    const snapshot = optionsRef.current;
    return {
      clipboardFallback: snapshot.clipboardFallback !== false,
      cleanup: {
        dictionary: snapshotDictionary(snapshot.dictionary ?? []),
        enabled: snapshot.cleanupEnabled === true,
        modelId: snapshot.cleanupModelId ?? null,
        style: snapshot.style ?? 'formal',
      },
      cleanupEngine: cleanupEngineRef.current,
      clipboard: snapshot.clipboard,
      deliveryPlatform: resolvePlatform(snapshot.clipboard, snapshot.deliveryPlatform),
      dogfood: snapshot.dogfood ?? dogfoodTranscribeAndCopy,
      history: snapshot.onHistoryRecord,
      modelId: snapshot.modelId,
      now: snapshot.now ?? Date.now,
      provenance: snapshot.createProvenance ?? createCleanupProvenance,
      reservation,
    };
  }, []);

  const runDogfood = useCallback(async (audio: CaptureAudioMeta) => {
    const session = sessionRef.current;
    const cancellation = cancellationRef.current;
    const current = () => session === sessionRef.current && !cancellation.cancelled;
    const admission = admissionRef.current ?? reserveAdmission();
    admissionRef.current = null;
    if (!admission) {
      setPhase('error');
      announce('Processing reservation was lost — audio was not accepted.');
      return;
    }
    const processing = { admission, session };
    processingRef.current = processing;
    let settlement: Promise<void> | undefined;
    // Consult the authoritative native latch on success AND failure. Its
    // notification may still be queued when STT or cleanup settles.
    const settleCancellation = () => settlement ??= (async () => {
      if (cancellation.cancelled) return;
      if (cancellation.scope) {
        let accepted = false;
        try { accepted = await cancellation.scope.finish(); } catch { /* fail closed */ }
        if (!accepted) {
          cancellation.cancelled = true;
          admission.reservation.cancel();
          if (session === sessionRef.current) cancelActionRef.current();
          return;
        }
      }
      if (current()) activeRef.current = false;
    })();
    cancellation.settle = settleCancellation;
    setPhase('queued');
    announce('Queued for processing…');
    let executionStarted = false;
    try {
      const modelId = resolveTranscriptionModelId(admission.modelId);
      const result = await admission.reservation.submit(async (signal) => {
        executionStarted = true;
        try {
          await ensureModelAvailable(admission.modelId);
          if (signal.aborted) throw new DOMException('Dictation cancelled', 'AbortError');
          if (current()) {
            setPhase('transcribing');
            announce('Transcribing…');
          }
          const result = await admission.dogfood({
            audio,
            cleanup: {
              admissionError: admission.cleanupError,
              engine: admission.cleanupEngine,
              requestId: admission.reservation.id,
              signal,
              snapshot: admission.cleanup,
            },
            clipboard: admission.clipboard,
            clipboardFallback: admission.clipboardFallback,
            deliveryPlatform: admission.deliveryPlatform,
            isCurrent: current,
            beforeDelivery: settleCancellation,
            snapshotTarget: async () => {
              const target = await admission.deliveryPlatform.snapshotTarget();
              if (current()) setIntendedTarget(target);
              return target;
            },
            modelId,
            onCleanupStart: () => {
              if (current() && admission.cleanup.enabled) {
                setPhase('cleaning');
                announce('Cleaning up locally…');
              }
            },
            onDeliveryStart: () => {
              if (current()) {
                setPhase('delivering');
                announce('Delivering…');
              }
            },
          });
          await settleCancellation();
          const provenance = await admission.provenance(admission.cleanup, result.cleanup);
          // Cancel blocks new writes, not evidence of an already invoked write.
          if ((signal.aborted || cancellation.cancelled) && !result.delivery.writeStarted) {
            throw new DOMException('Dictation cancelled', 'AbortError');
          }
          const record = createDogfoodRecord({
            cleanup: provenance,
            durationMs: audio.duration_ms,
            id: `dogfood-${audio.id}`,
            mayHaveInserted: result.delivery.mayHaveInserted,
            model: modelId,
            now: admission.now(),
            rawText: result.rawTranscript?.rawText ?? result.rawTranscript?.text
              ?? result.transcript.rawText ?? result.transcript.text,
            status: result.delivery.status,
            style: admission.cleanup.style,
            text: result.transcript.text,
          });
          if (record) admission.history?.(record);
          return result;
        } finally {
          await releaseCleanupLease(admission);
        }
      });
      await settleCancellation();
      if (cancellation.cancelled) {
        if (result.delivery.writeStarted) optionsRef.current.onToast?.(result.delivery.message);
        return;
      }
      if (current()) {
        setTranscript(result.transcript);
        setHudResult(hudResultFor(result.delivery));
        setPhase('success');
        announce(result.delivery.message);
      } else {
        optionsRef.current.onToast?.(result.delivery.message);
      }
    } catch (error: unknown) {
      await settleCancellation();
      if (cancellation.cancelled) return;
      if (error instanceof SttError && error.code === 'no-speech') {
        if (current()) {
          setPhase('idle');
          announce(error.message);
        }
        return;
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (current()) {
          setPhase('cancelled');
          setMessage('Dictation cancelled — nothing delivered.');
        }
        return;
      }
      if (current()) {
        setHudResult('transcribe-failed');
        setPhase('error');
        announce(errorText(error));
      } else {
        optionsRef.current.onToast?.(errorText(error));
      }
    } finally {
      // A queued cancellation never enters execute's own finally.
      if (!executionStarted) await releaseCleanupLease(admission);
      if (processingRef.current === processing) processingRef.current = null;
      await cancellation.scope?.dispose().catch(() => {});
    }
  }, [announce, ensureModelAvailable, reserveAdmission]);

  const handledAudioIdsRef = useRef(new Set<string>());
  useEffect(() => {
    if (capture.captureState.kind === 'cancelled' || capture.captureState.kind === 'error') {
      if (admissionRef.current) cancelAdmission(admissionRef.current);
      admissionRef.current = null;
      setPhase(capture.captureState.kind);
      setMessage(capture.captureState.kind === 'error'
        ? capture.captureState.message : 'Capture cancelled — nothing transcribed.');
      return;
    }
    if (capture.captureState.kind !== 'stopped') return;
    const audio = capture.captureState.audio;
    if (!audio) {
      if (admissionRef.current) cancelAdmission(admissionRef.current);
      admissionRef.current = null;
      setPhase('error');
      announce('Capture stopped without audio — nothing to transcribe.');
      return;
    }
    if (handledAudioIdsRef.current.has(audio.id)) return;
    handledAudioIdsRef.current.add(audio.id);
    void runDogfood(audio);
  }, [announce, capture.captureState, runDogfood]);

  const start = useCallback(async (source: 'home' | 'gesture' = 'home') => {
    if (admissionRef.current) return;
    const admission = reserveAdmission();
    if (!admission) {
      setPhase('error');
      announce('Processing queue is full — wait before starting another capture.');
      return;
    }
    admissionRef.current = admission;
    const abandon = () => {
      cancelAdmission(admission);
      if (admissionRef.current === admission) admissionRef.current = null;
    };
    const session = ++sessionRef.current;
    const previous = cancellationRef.current;
    const retire = previous.settle?.() ?? previous.scope?.dispose().catch(() => {});
    const retirement = retire || retirementRef.current
      ? Promise.all([retirementRef.current, retire]).then(() => {}) : undefined;
    retirementRef.current = retirement;
    const cancellation: Cancellation = { cancelled: false };
    cancellationRef.current = cancellation;
    activeRef.current = true;
    setScopeReady(false);
    setHudReady(false);
    setPhase('starting');
    setOrigin(source);
    const superseded = () => session !== sessionRef.current;
    setTranscript(null);
    setHudResult(null);
    setMessage(null);
    stopRequestedRef.current = false;
    setIntendedTarget(null);
    try {
      if (retirement) await retirement;
      if (superseded()) { abandon(); return; }
      try {
        cancellation.scope = await beginCancelScope(() => {
          cancellation.cancelled = true;
          if (session === sessionRef.current) cancelActionRef.current();
        }, () => !superseded() && !cancellation.cancelled);
      } catch (error: unknown) {
        console.warn('Escape cancellation unavailable; dictating without it.', error);
      }
      if (superseded()) {
        abandon();
        await cancellation.scope?.dispose();
        return;
      }
      if (cancellation.scope) setScopeReady(true);
      setHudReady(true);
      await ensureModelAvailable(admission.modelId);
      if (superseded()) { abandon(); return; }
      if (admission.cleanup.enabled && admission.cleanup.modelId) {
        try {
          await admission.cleanupEngine.acquire?.(admission.reservation.id, admission.cleanup.modelId);
        } catch (error: unknown) {
          admission.cleanupError = error instanceof CleanupEngineError
            ? error : new CleanupEngineError('runtime-error', errorText(error));
        }
      }
      if (superseded()) { abandon(); return; }
      if (stopRequestedRef.current) {
        abandon();
        setPhase('cancelled');
        setMessage('Capture cancelled — nothing transcribed.');
        return;
      }
      const deviceId = options.preferredDeviceId
        && options.preferredDeviceId !== SYSTEM_DEFAULT_DEVICE_ID
        ? options.preferredDeviceId : undefined;
      const started = await capture.startFullCaptureSession(deviceId);
      if (superseded() || started === 'ended') { abandon(); return; }
      if (started !== 'started') {
        abandon();
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
      abandon();
      if (superseded()) return;
      setPhase('error');
      announce(errorText(error));
    }
  }, [announce, capture, ensureModelAvailable, options.preferredDeviceId, reserveAdmission]);

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
    const session = sessionRef.current;
    const processing = processingRef.current;
    if (admissionRef.current) cancelAdmission(admissionRef.current);
    else if (processing?.session === session) processing.admission.reservation.cancel();
    admissionRef.current = null;
    activeRef.current = false;
    setScopeReady(false);
    setHudReady(false);
    cancellationRef.current.cancelled = true;
    void cancellationRef.current.scope?.dispose().catch(() => {});
    sessionRef.current += 1;
    stopRequestedRef.current = true;
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

  const cancellable = phase === 'starting' || phase === 'recording'
    || phase === 'queued' || phase === 'transcribing' || phase === 'cleaning';
  return {
    cancel,
    captureState: capture.captureState,
    intendedTarget,
    message,
    origin,
    hudResult,
    phase,
    scopeReady: scopeReady && cancellable,
    hudReady: hudReady && cancellable,
    start,
    stop,
    transcript,
  };
}
