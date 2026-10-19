/// Wire full capture stop → dogfoodTranscribeAndCopy on the main UI.
/// Automatic STT + optional local cleanup (BUS-16) + delivery after a clean
/// stop; cancel discards with no STT, and a cancel during cleanup delivers
/// nothing either.
/// Snapshots intended target after final transcription (ADR §4).
/// Shared by Home Start and global hold/latch — start() must not activate
/// Voxloom; gesture callers rely on the other app still being frontmost.
/// Never silent-downloads missing models — surfaces a clear UI error instead.
///
/// Composes: session lifecycle (useDogfoodSession), post-stop processing
/// (useDogfoodProcessing), the native cleanup engine (useCleanupEngine), and
/// phase/HUD state (dogfoodPhase).

import { useCallback, useRef } from 'react';
import type { DictationRecord, WritingStyle } from '../../domain/types';
import type { CaptureState } from '../capture/types';
import {
  useCaptureState,
  type UseCaptureStateResult,
} from '../capture/useCaptureState';
import type { ClipboardAdapter } from '../clipboard';
import type { CleanupEngine } from '../cleanup/contracts';
import type { DeliveryPlatformAdapter, TargetSnapshot } from '../delivery';
import type { OverlayResult } from '../shortcut/overlayVisibility';
import type { SttModelStore } from './contracts';
import { ensureModelAvailable } from './dogfoodModel';
import type { dogfoodTranscribeAndCopy } from './dogfoodPath';
import {
  cancellablePhase,
  useDogfoodView,
  type DogfoodOrigin,
  type DogfoodPhase,
} from './dogfoodPhase';
import { useDogfoodLiveSession } from './dogfoodSessionState';
import { createSttModelStore } from './factory';
import type { Transcript } from './types';
import { useCleanupEngine } from './useCleanupEngine';
import { useDogfoodProcessing } from './useDogfoodProcessing';
import { useDogfoodSession } from './useDogfoodSession';

export {
  errorText,
  MODEL_DAMAGED_MESSAGE,
  MODEL_READ_FAILED_MESSAGE,
} from './dogfoodModel';
export { hudResultFor, type DogfoodPhase } from './dogfoodPhase';

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
  /** Writing style stamped onto the history row and used by cleanup. */
  style?: WritingStyle;
  /**
   * Run local cleanup: `isCleanupActive(settings)`, i.e. `cleanupOptIn`;
   * the legacy `cleanupEnabled` is ignored (BUS-16). Default off.
   */
  cleanupActive?: boolean;
  /** Settings `cleanupModelId`. */
  cleanupModelId?: string | null;
  /** Dictionary words sent to cleanup as canonical spellings. */
  dictionary?: readonly string[];
  /** Test seam: cleanup engine (defaults to the native worker). */
  cleanupEngine?: CleanupEngine;
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
  origin: DogfoodOrigin | null;
  phase: DogfoodPhase;
  /** Current session has acquired its Escape cancellation scope. */
  scopeReady: boolean;
  /**
   * The Escape arm attempt has settled (armed or unavailable), so the HUD may
   * show. A failed arm shows a plain, non-cancellable HUD; it never hides it.
   */
  hudReady: boolean;
  start: (origin?: DogfoodOrigin) => Promise<void>;
  stop: () => Promise<void>;
  transcript: Transcript | null;
}

export function useDogfoodCapture(
  options: UseDogfoodCaptureOptions,
): UseDogfoodCaptureResult {
  const liveCapture = useCaptureState();
  const capture = options.captureApi ?? liveCapture;
  const { actions, state } = useDogfoodView(options.onToast);
  const live = useDogfoodLiveSession();
  const { cleanupEngine, disposeNativeEngine } = useCleanupEngine(options.cleanupEngine);

  const storeRef = useRef(
    (options.createModelStore ?? createSttModelStore)(),
  );
  if (options.createModelStore) {
    storeRef.current = options.createModelStore();
  }
  const modelIdRef = useRef(options.modelId);
  modelIdRef.current = options.modelId;
  const ensureModel = useCallback(
    () => ensureModelAvailable(storeRef.current, modelIdRef.current),
    [],
  );

  useDogfoodProcessing({
    actions, captureState: capture.captureState, cleanupEngine, ensureModel, live, options,
  });
  const { cancel, start, stop } = useDogfoodSession({
    actions,
    capture,
    disposeNativeEngine,
    ensureModel,
    live,
    phase: state.phase,
    preferredDeviceId: options.preferredDeviceId,
  });

  return {
    cancel,
    captureState: capture.captureState,
    intendedTarget: state.intendedTarget,
    message: state.message,
    origin: state.origin,
    hudResult: state.hudResult,
    phase: state.phase,
    scopeReady: state.scopeReady && cancellablePhase(state.phase),
    hudReady: state.hudReady && cancellablePhase(state.phase),
    start,
    stop,
    transcript: state.transcript,
  };
}
