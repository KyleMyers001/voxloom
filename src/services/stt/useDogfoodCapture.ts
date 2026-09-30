/// Wire full capture stop → dogfoodTranscribeAndCopy on the main UI.
/// Automatic STT + delivery after a clean stop; cancel discards with no STT.
/// Snapshots intended target at capture start (ADR §4 invocation policy).
/// Shared by Home Start and global hold/latch — start() must not activate
/// Voxloom; gesture callers rely on the other app still being frontmost.
/// Never silent-downloads missing models — surfaces a clear UI error instead.

import { useCallback, useEffect, useRef, useState } from 'react';

import { createDogfoodRecord } from '../../domain/records';
import type { DictationRecord, WritingStyle } from '../../domain/types';
import type { ClipboardAdapter } from '../clipboard';
import {
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
  type DogfoodResult,
} from './dogfoodPath';
import { createSttModelStore } from './factory';
import { resolveTranscriptionModelId } from './resolveModelId';
import { SttError, type Transcript } from './types';

export type DogfoodPhase =
  | 'idle'
  | 'recording'
  | 'queued'
  | 'transcribing'
  | 'cleaning'
  | 'success'
  | 'error'
  | 'cancelled';

export interface UseDogfoodCaptureOptions {
  clipboard: ClipboardAdapter;
  /** Settings `clipboardFallback` (default true). */
  clipboardFallback?: boolean;
  cleanupEnabled?: boolean;
  cleanupModelId?: string | null;
  dictionary?: readonly string[];
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
  /** Test seam: delayed provenance hashing. */
  createProvenance?: typeof createCleanupProvenance;
  cleanupEngine?: CleanupEngine;
  /** Test seam: dogfood path. */
  dogfood?: typeof dogfoodTranscribeAndCopy;
  /** Test seam: delivery platform (snapshot / insert / clipboard). */
  deliveryPlatform?: DeliveryPlatformAdapter;
}

export interface UseDogfoodCaptureResult {
  cancel: () => void;
  captureState: CaptureState;
  /** Invocation-time intended target (null until start snapshots). */
  intendedTarget: TargetSnapshot | null;
  message: string | null;
  origin: 'home' | 'gesture' | null;
  phase: DogfoodPhase;
  start: (origin?: 'home' | 'gesture') => Promise<void>;
  stop: () => Promise<void>;
  transcript: Transcript | null;
}

interface Admission {
  clipboardFallback: boolean;
  cleanup: CleanupSnapshot;
  cleanupEngine: CleanupEngine;
  clipboard: ClipboardAdapter;
  deliveryPlatform: DeliveryPlatformAdapter;
  dogfood: typeof dogfoodTranscribeAndCopy;
  history: ((record: DictationRecord) => void) | undefined;
  intended: TargetSnapshot | null;
  modelId: string;
  now: () => number;
  provenance: typeof createCleanupProvenance;
  reservation: ProcessingReservation<DogfoodResult>;
}

interface ProcessingAdmission {
  admission: Admission;
  session: number;
}

function errorText(error: unknown): string {
  if (error instanceof SttError) {
    if (error.code === 'model-missing') {
      return (
        `${error.message} Open Settings → Speech-to-text models and `
        + 'Download the selected model first.'
      );
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function missingModelMessage(modelId: string, status: string | null): string {
  const detail = status ? ` (status: ${status})` : '';
  return (
    `Model “${modelId}” is not downloaded${detail}. `
    + 'Open Settings → Speech-to-text models and Download it first '
    + '(no silent download).'
  );
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
    // The job is settled; release failure must not rewrite its evidence.
  }
}

function cancelAdmission(admission: Admission): void {
  admission.reservation.cancel();
  void releaseCleanupLease(admission);
}

export function useDogfoodCapture(
  options: UseDogfoodCaptureOptions,
): UseDogfoodCaptureResult {
  const liveCapture = useCaptureState();
  const capture = options.captureApi ?? liveCapture;

  const [phase, setPhase] = useState<DogfoodPhase>('idle');
  const [origin, setOrigin] = useState<'home' | 'gesture' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [intendedTarget, setIntendedTarget] =
    useState<TargetSnapshot | null>(null);
  const coordinatorRef = useRef(
    new DictationCoordinator<DogfoodResult>(2),
  );
  const admissionRef = useRef<Admission | null>(null);
  const processingRef = useRef<ProcessingAdmission | null>(null);
  const cleanupEngineRef = useRef(
    options.cleanupEngine ?? createTauriCleanupEngine(),
  );

  const dogfoodRef = useRef(options.dogfood ?? dogfoodTranscribeAndCopy);
  dogfoodRef.current = options.dogfood ?? dogfoodTranscribeAndCopy;
  const storeRef = useRef(
    (options.createModelStore ?? createSttModelStore)(),
  );
  if (options.createModelStore) {
    storeRef.current = options.createModelStore();
  }

  const clipboardRef = useRef(options.clipboard);
  clipboardRef.current = options.clipboard;
  const toastRef = useRef(options.onToast);
  toastRef.current = options.onToast;
  const historyRef = useRef(options.onHistoryRecord);
  historyRef.current = options.onHistoryRecord;
  const nowRef = useRef(options.now ?? Date.now);
  nowRef.current = options.now ?? Date.now;
  const platformRef = useRef<DeliveryPlatformAdapter>(
    resolvePlatform(options.clipboard, options.deliveryPlatform),
  );
  platformRef.current = resolvePlatform(
    options.clipboard,
    options.deliveryPlatform,
  );
  const intendedRef = useRef<TargetSnapshot | null>(null);
  /** Set by stop/cancel so a finish that races start still terminates. */
  const stopRequestedRef = useRef(false);
  /**
   * Bumped by start/cancel. A prior session's STT/delivery may still be in
   * flight when the next hold starts; its completion must still deliver and
   * record history, but must not overwrite the newer session's phase.
   */
  const sessionRef = useRef(0);

  useEffect(() => {
    // A fresh engine on effect setup also handles React StrictMode remounts.
    // Unmount is an extra retirement path, not a substitute for native hooks.
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
    const current = () => session === sessionRef.current;
    const admission = admissionRef.current;
    admissionRef.current = null;
    if (!admission) {
      setPhase('error');
      announce('Processing reservation was lost — audio was not accepted.');
      return;
    }
    const processing = { admission, session };
    processingRef.current = processing;
    setPhase('queued');
    announce('Queued for processing…');
    let executionStarted = false;
    try {
      const modelId = resolveTranscriptionModelId(admission.modelId);
      const result = await admission.reservation.submit(async (signal) => {
        executionStarted = true;
        try {
          await ensureModelAvailable(admission.modelId);
          if (current()) {
            setPhase('transcribing');
            announce('Transcribing…');
          }
          const result = await admission.dogfood({
            audio,
            cleanup: {
              engine: admission.cleanupEngine,
              requestId: admission.reservation.id,
              signal,
              snapshot: admission.cleanup,
            },
            clipboard: admission.clipboard,
            clipboardFallback: admission.clipboardFallback,
            deliveryPlatform: admission.deliveryPlatform,
            intended: admission.intended,
            modelId,
            onCleanupStart: () => {
              if (current() && admission.cleanup.enabled) {
                setPhase('cleaning');
                announce('Cleaning up locally…');
              }
            },
          });
          const provenance = await admission.provenance(
            admission.cleanup,
            result.cleanup,
          );
          if (signal.aborted && !result.delivery.writeStarted) {
            throw new DOMException('Dictation cancelled', 'AbortError');
          }
          const record = createDogfoodRecord({
            cleanup: provenance,
            durationMs: audio.duration_ms,
            id: `dogfood-${audio.id}`,
            model: modelId,
            now: admission.now(),
            rawText: result.rawTranscript?.text ?? result.transcript.text,
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
      if (current()) {
        setTranscript(result.transcript);
        setPhase('success');
      }
      // Stale session: evidence still surfaces as a toast, phase untouched.
      if (current()) announce(result.delivery.message);
      else toastRef.current?.(result.delivery.message);
    } catch (error: unknown) {
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
        setPhase('error');
        announce(errorText(error));
      } else {
        toastRef.current?.(errorText(error));
      }
    } finally {
      // Queued cancellation rejects submit without ever entering execute.
      // Active runs retain their lease until execute's own finally settles.
      if (!executionStarted) await releaseCleanupLease(admission);
      if (processingRef.current === processing) {
        processingRef.current = null;
      }
    }
  }, [announce, ensureModelAvailable]);

  // Auto dogfood on clean stop (user stop or 120s/capacity bound).
  const handledAudioIdsRef = useRef(new Set<string>());
  useEffect(() => {
    if (capture.captureState.kind === 'cancelled') {
      if (admissionRef.current) cancelAdmission(admissionRef.current);
      admissionRef.current = null;
      setPhase('cancelled');
      setMessage('Capture cancelled — nothing transcribed.');
      return;
    }
    if (capture.captureState.kind === 'error') {
      if (admissionRef.current) cancelAdmission(admissionRef.current);
      admissionRef.current = null;
      setPhase('error');
      setMessage(capture.captureState.message);
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
    if (admissionRef.current) {
      announce('A capture session is already starting or recording.');
      return;
    }
    const reservation = coordinatorRef.current.reserve();
    if (!reservation) {
      setPhase('error');
      announce(
        'Processing queue is full — wait before starting another capture.',
      );
      return;
    }
    const admission: Admission = {
      clipboardFallback: options.clipboardFallback !== false,
      cleanup: {
        dictionary: snapshotDictionary(options.dictionary ?? []),
        enabled: options.cleanupEnabled === true,
        modelId: options.cleanupModelId ?? null,
        style: options.style ?? 'formal',
      },
      cleanupEngine: cleanupEngineRef.current,
      clipboard: clipboardRef.current,
      deliveryPlatform: platformRef.current,
      dogfood: dogfoodRef.current,
      history: historyRef.current,
      intended: null,
      modelId: options.modelId,
      now: nowRef.current,
      provenance: options.createProvenance ?? createCleanupProvenance,
      reservation,
    };
    admissionRef.current = admission;
    const abandon = () => {
      reservation.cancel();
      void releaseCleanupLease(admission);
      if (admissionRef.current === admission) admissionRef.current = null;
    };
    const session = ++sessionRef.current;
    setOrigin(source);
    const superseded = () => session !== sessionRef.current;
    setTranscript(null);
    setMessage(null);
    stopRequestedRef.current = false;
    try {
      await ensureModelAvailable(admission.modelId);
    } catch (error: unknown) {
      abandon();
      if (superseded()) return;
      setPhase('error');
      announce(errorText(error));
      return;
    }
    if (superseded()) {
      abandon();
      return;
    }
    if (admission.cleanup.enabled && admission.cleanup.modelId) {
      try {
        await admission.cleanupEngine.acquire?.(
          reservation.id,
          admission.cleanup.modelId,
        );
      } catch {
        admission.cleanup = { ...admission.cleanup, modelId: null };
      }
    }
    if (superseded()) {
      abandon();
      return;
    }

    // ADR §4: snapshot intended target at invocation (capture start).
    try {
      const snap = await admission.deliveryPlatform.snapshotTarget();
      if (superseded()) {
        abandon();
        return;
      }
      intendedRef.current = snap;
      admission.intended = snap;
      setIntendedTarget(snap);
    } catch {
      if (superseded()) {
        abandon();
        return;
      }
      intendedRef.current = null;
      admission.intended = null;
      setIntendedTarget(null);
    }

    // Hold release may have already requested stop while we were snapshotting.
    if (stopRequestedRef.current) {
      abandon();
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
      if (superseded() || started === 'ended') {
        abandon();
        return;
      }
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
      if (superseded()) {
        abandon();
        return;
      }
      abandon();
      setPhase('error');
      announce(errorText(error));
    }
  }, [
    announce,
    capture,
    ensureModelAvailable,
    options.cleanupEnabled,
    options.cleanupModelId,
    options.clipboardFallback,
    options.createProvenance,
    options.dictionary,
    options.modelId,
    options.preferredDeviceId,
    options.style,
  ]);

  const stop = useCallback(async () => {
    stopRequestedRef.current = true;
    try {
      await capture.stopFullCapture();
    } catch (error: unknown) {
      setPhase('error');
      announce(errorText(error));
    }
  }, [announce, capture]);

  const cancel = useCallback(() => {
    const session = sessionRef.current;
    const processing = processingRef.current;
    if (admissionRef.current) {
      cancelAdmission(admissionRef.current);
    } else if (processing?.session === session) {
      processing.admission.reservation.cancel();
    }
    sessionRef.current += 1;
    stopRequestedRef.current = true;
    intendedRef.current = null;
    admissionRef.current = null;
    setIntendedTarget(null);
    try {
      capture.cancelActiveCapture();
    } finally {
      setPhase('cancelled');
      setMessage('Capture cancelled — nothing transcribed.');
    }
  }, [capture]);

  return {
    cancel,
    captureState: capture.captureState,
    intendedTarget,
    message,
    origin,
    phase,
    start,
    stop,
    transcript,
  };
}

