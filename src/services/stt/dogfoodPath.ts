/// Dogfood STT path: capture audio handle → selected model → optional local
/// cleanup (BUS-16) → delivery.
/// Prefer insert (BUS-14); Copy sink remains the reliable floor.
/// No gestures. Model must already be selected; never starts a download.
/// Delivery soft-fails: STT success still returns the transcript when
/// insert/Copy cannot complete (manual recovery always available).

import type { CleanupOutcome } from '../cleanup/types';
import type { ClipboardAdapter } from '../clipboard';
import {
  createStubDeliveryAdapter,
  createTauriDeliveryAdapter,
  deliverTranscript,
  deliveryMessage,
  insertIntoOwnField,
  type DeliveryOutcome,
  type DeliveryPlatformAdapter,
  type PasteBinding,
  type TargetSnapshot,
} from '../delivery';
import type { SttEngine } from './contracts';
import { newestFirst } from '../dictionary/format';
import { withDictionary } from './dogfoodDictionary';
import { audioHandleFromCapture } from './fromCapture';
import { createSttEngine } from './factory';
import { explainEmptyTranscript } from './noSpeech';
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
  /**
   * Called after final STT (including engine cleanup), never during capture.
   * Defaults to the platform snapshot. Null means unavailable → Copy/Fail.
   */
  snapshotTarget?: () => Promise<TargetSnapshot | null>;
  /**
   * The paste terminal in front when dictation started (captured at hold
   * start, not here). Null: nothing may be pasted.
   */
  pasteBinding?: PasteBinding | null;
  /** False after cancel/supersession: no new target lookup or delivery writes. */
  isCurrent?: () => boolean;
  /**
   * Optional local cleanup of the final transcript (BUS-16). Runs only for a
   * current session with text. Must not throw; any failure must come back as
   * a raw-text fallback. `cancelled` (the user's cancel) delivers nothing.
   */
  cleanup?: (text: string) => Promise<CleanupOutcome>;
  /**
   * The user's dictionary words (BUS-138). Entries are spelled exactly as
   * saved in the transcript, right after STT and again after cleanup. History
   * keeps the engine output as `rawText`. Empty or missing: no change.
   */
  dictionary?: readonly string[];
  /** Close the native cancellation window before target lookup or delivery. */
  beforeDelivery?: () => Promise<void>;
  /**
   * Explicit selected model id (Settings `transcriptionModel`).
   * Resolved via `resolveTranscriptionModelId` — never auto-downloaded.
   */
  modelId: string;
  /** Prepared native Parakeet session identity; no PCM crosses the renderer. */
  requestId?: string;
  /** Optional engine factory (tests); defaults to env whisper/mock. */
  createEngine?: (modelId: string) => SttEngine;
  /** Injectable delivery platform (tests). */
  deliveryPlatform?: DeliveryPlatformAdapter;
  /**
   * BUS-201: write into a focused Voxloom text field; false = not one, so
   * delivery continues normally. Defaults to `insertIntoOwnField` (tests).
   */
  insertOwnField?: (text: string) => boolean;
}

export interface DogfoodResult {
  /** Present when cleanup ran (never `cancelled`: that throws AbortError). */
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

async function cleanUp(
  options: DogfoodTranscribeOptions,
  transcript: Transcript,
): Promise<CleanupOutcome | undefined> {
  if (!options.cleanup || !transcript.text.trim()) return undefined;
  if (!(options.isCurrent?.() ?? true)) return undefined;
  try {
    return await options.cleanup(transcript.text);
  } catch {
    // The stage must not throw; if it does, deliver the raw transcript.
    return { finalText: transcript.text, reason: 'runtime-error', status: 'fallback' };
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
  const engine = options.createEngine
    ? options.createEngine(modelId)
    : createSttEngine(modelId, options.requestId);
  const handle = audioHandleFromCapture(options.audio);
  const sttTranscript = withDictionary(
    await engine.transcribe(handle, {
      dictionary: newestFirst(options.dictionary ?? []),
    }),
    options.dictionary,
  );
  const cleanup = await cleanUp(options, sttTranscript);
  if (cleanup?.status === 'cancelled') {
    throw new DOMException('Dictation cancelled', 'AbortError');
  }
  // History keeps the engine output; delivery uses the cleaned text. The
  // dictionary runs again because cleanup may have undone a spelling.
  const transcript: Transcript = cleanup?.status === 'cleaned'
    ? withDictionary({
        ...sttTranscript,
        rawText: sttTranscript.rawText ?? sttTranscript.text,
        text: cleanup.finalText,
      }, options.dictionary)
    : sttTranscript;
  if (options.isCurrent?.() ?? true) await options.beforeDelivery?.();

  const platform = resolvePlatform(
    options.clipboard,
    options.deliveryPlatform,
  );
  const clipboardFallback = options.clipboardFallback !== false;

  const insertOwnField = options.insertOwnField ?? insertIntoOwnField;
  if (transcript.text.trim() && (options.isCurrent?.() ?? true)
    && insertOwnField(transcript.text)) {
    const delivery: DeliveryOutcome = {
      clipboardRestored: false,
      detail: 'Voxloom field',
      message: deliveryMessage('inserted', null),
      restoreSkippedReason: null,
      status: 'inserted',
      text: transcript.text,
    };
    return { cleanup, copied: false, delivery, transcript };
  }

  try {
    let intended: TargetSnapshot | null = null;
    if (transcript.text.trim() && (options.isCurrent?.() ?? true)) {
      try {
        intended = await (options.snapshotTarget ?? (() => platform.snapshotTarget()))();
      } catch {
        // Unavailable AX must still honor the user's Copy fallback setting.
      }
    }
    const delivery = explainEmptyTranscript(
      await deliverTranscript({
        clipboardFallback,
        isCurrent: options.isCurrent,
        intended,
        pasteBinding: options.pasteBinding,
        platform,
        text: transcript.text,
      }),
      transcript,
    );
    return {
      cleanup,
      copied: delivery.status === 'copied',
      copyWarning: delivery.status === 'failed'
        ? (delivery.detail ?? delivery.message)
        : undefined,
      delivery,
      transcript,
    };
  } catch (error: unknown) {
    const copyWarning = error instanceof Error
      ? error.message
      : String(error);
    const delivery: DeliveryOutcome = {
      clipboardRestored: false,
      detail: copyWarning,
      message: `Failed — ${copyWarning}`,
      restoreSkippedReason: null,
      status: 'failed',
      text: transcript.text,
    };
    return { cleanup, copied: false, copyWarning, delivery, transcript };
  }
}
