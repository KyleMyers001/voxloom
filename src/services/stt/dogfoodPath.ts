/// Dogfood STT path: capture audio handle → selected model → delivery.
/// Prefer insert (BUS-14); Copy sink remains the reliable floor.
/// No gestures. Model must already be selected; never starts a download.
/// Delivery soft-fails: STT success still returns the transcript when
/// insert/Copy cannot complete (manual recovery always available).

import type { ClipboardAdapter } from '../clipboard';
import {
  runCleanup,
  type CleanupEngine,
  type CleanupOutcome,
  type CleanupSnapshot,
} from '../cleanup';
import type { ProcessingSignal } from '../dictation/coordinator';
import {
  createStubDeliveryAdapter,
  createTauriDeliveryAdapter,
  deliverTranscript,
  type DeliveryOutcome,
  type DeliveryPlatformAdapter,
  type TargetSnapshot,
} from '../delivery';
import { DeliveryCancelledError } from '../delivery/types';
import type { SttEngine } from './contracts';
import { audioHandleFromCapture } from './fromCapture';
import { createSttEngine } from './factory';
import { resolveTranscriptionModelId } from './resolveModelId';
import type { Transcript } from './types';

export interface CaptureAudioMeta {
  duration_ms: number;
  id: string;
  sample_rate_hz: number;
}

export interface DogfoodTranscribeOptions {
  /** Opaque capture-stopped audio metadata (no PCM over IPC). */
  audio: CaptureAudioMeta;
  clipboard: ClipboardAdapter;
  /**
   * Settings `clipboardFallback`. Default true (fixtures / ADR).
   * When false, insert failure surfaces Failed + manual recovery — no Copy.
   */
  clipboardFallback?: boolean;
  cleanup?: {
    engine: CleanupEngine;
    requestId: string;
    signal: ProcessingSignal;
    snapshot: CleanupSnapshot;
  };
  onCleanupStart?: () => void;
  /**
   * Invocation-time intended target snapshot (ADR §4).
   * When omitted, delivery treats the target as unavailable → Copy/Fail.
   */
  intended?: TargetSnapshot | null;
  /**
   * Explicit selected model id (Settings `transcriptionModel`).
   * Resolved via `resolveTranscriptionModelId` — never auto-downloaded.
   */
  modelId: string;
  /** Optional engine factory (tests); defaults to env whisper/mock. */
  createEngine?: (modelId: string) => SttEngine;
  /** Injectable delivery platform (tests). */
  deliveryPlatform?: DeliveryPlatformAdapter;
}

export interface DogfoodResult {
  cleanup?: CleanupOutcome;
  /**
   * True when Copy (clipboard write) completed successfully.
   * Kept for older callers; prefer `delivery.status`.
   */
  copied: boolean;
  /** Present when STT succeeded but Copy/delivery soft-failed. */
  copyWarning?: string;
  /** Evidence-backed delivery outcome (Inserted / Copied / Failed). */
  delivery: DeliveryOutcome;
  rawTranscript?: Transcript;
  transcript: Transcript;
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

/**
 * Transcribe a deposited capture buffer with the **selected** model and
 * deliver via insert-preferring policy (Copy floor). Soft-fails delivery:
 * STT success always returns `transcript` even if insert/Copy throws.
 */
export async function dogfoodTranscribeAndCopy(
  options: DogfoodTranscribeOptions,
): Promise<DogfoodResult> {
  const modelId = resolveTranscriptionModelId(options.modelId);
  const engine = (options.createEngine ?? createSttEngine)(modelId);
  const handle = audioHandleFromCapture(options.audio);
  const transcript = await engine.transcribe(handle);
  options.onCleanupStart?.();
  const cleanup = options.cleanup
    ? await runCleanup({
        engine: options.cleanup.engine,
        rawText: transcript.text,
        requestId: options.cleanup.requestId,
        signal: options.cleanup.signal,
        snapshot: options.cleanup.snapshot,
      })
    : { finalText: transcript.text, status: 'skipped' as const };
  if (cleanup.status === 'cancelled') {
    throw new DOMException('Dictation cancelled', 'AbortError');
  }
  const finalTranscript = { ...transcript, text: cleanup.finalText };

  const platform = resolvePlatform(
    options.clipboard,
    options.deliveryPlatform,
  );
  const clipboardFallback = options.clipboardFallback !== false;

  try {
    const delivery = await deliverTranscript({
      clipboardFallback,
      canWrite: () => !options.cleanup?.signal.aborted,
      intended: options.intended ?? null,
      platform,
      text: finalTranscript.text,
    });
    return {
      copied: delivery.status === 'copied',
      copyWarning: delivery.status === 'failed'
        ? (delivery.detail ?? delivery.message)
        : undefined,
      cleanup,
      delivery,
      rawTranscript: transcript,
      transcript: finalTranscript,
    };
  } catch (error: unknown) {
    if (error instanceof DeliveryCancelledError) {
      throw new DOMException('Dictation cancelled', 'AbortError');
    }
    const copyWarning = error instanceof Error
      ? error.message
      : String(error);
    const delivery: DeliveryOutcome = {
      clipboardRestored: false,
      detail: copyWarning,
      message: `Failed — ${copyWarning}`,
      restoreSkippedReason: null,
      status: 'failed',
      text: finalTranscript.text,
    };
    return {
      cleanup,
      copied: false,
      copyWarning,
      delivery,
      rawTranscript: transcript,
      transcript: finalTranscript,
    };
  }
}
