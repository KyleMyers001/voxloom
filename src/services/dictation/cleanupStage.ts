/// Optional local LLM cleanup between STT and delivery (BUS-16 PR 2c).
/// It never throws and never loses the transcript: a failure, timeout,
/// native abort or validator reject falls back to the raw text. Only the
/// user's own cancel returns `cancelled`, which delivers nothing, as a cancel
/// during transcription already does.

import type { CleanupEngine } from '../cleanup/contracts';
import { runCleanup } from '../cleanup/runCleanup';
import {
  CleanupEngineError,
  type CleanupOutcome,
  type CleanupSnapshot,
} from '../cleanup/types';
import type { ProcessingSignal } from './signal';

/** Lease plus run, end to end. The lease may hash the model file first. */
export const CLEANUP_STAGE_TIMEOUT_MS = 30_000;

export interface CleanupStageInput {
  engine: CleanupEngine;
  rawText: string;
  requestId: string;
  /** Aborted by the user's cancel or by a newer dictation superseding this one. */
  signal: ProcessingSignal;
  snapshot: CleanupSnapshot;
  timeoutMs?: number;
  /** True only for the user's cancel; a superseded run falls back to raw. */
  userCancelled: () => boolean;
}

function asEngineError(error: unknown): CleanupEngineError {
  return error instanceof CleanupEngineError
    ? error
    : new CleanupEngineError('runtime-error', String(error));
}

/** Acquire the native model lease, bounded by the stage deadline and abort. */
async function acquireLease(
  input: CleanupStageInput,
  timeoutMs: number,
): Promise<CleanupEngineError | undefined> {
  const { engine, requestId, signal, snapshot } = input;
  if (!snapshot.modelId || !engine.acquire) return undefined;
  if (signal.aborted) return new CleanupEngineError('cancelled', 'Dictation cancelled');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopListening = (): void => {};
  try {
    return await Promise.race([
      engine.acquire(requestId, snapshot.modelId).then(() => undefined, asEngineError),
      new Promise<CleanupEngineError>((resolve) => {
        timer = setTimeout(() => resolve(new CleanupEngineError(
          'timeout', 'Cleanup model lease timed out',
        )), timeoutMs);
      }),
      new Promise<CleanupEngineError>((resolve) => {
        stopListening = signal.onAbort(() => resolve(new CleanupEngineError(
          'cancelled', 'Dictation cancelled',
        ))) ?? stopListening;
      }),
    ]);
  } finally {
    clearTimeout(timer);
    stopListening();
  }
}

function fallback(
  rawText: string,
  reason: 'cancelled' | 'runtime-error',
  attempt?: CleanupOutcome['attempt'],
): CleanupOutcome {
  return { ...(attempt ? { attempt } : {}), finalText: rawText, reason, status: 'fallback' };
}

export async function cleanTranscript(input: CleanupStageInput): Promise<CleanupOutcome> {
  const { engine, rawText, requestId, signal, snapshot } = input;
  if (!snapshot.enabled || !rawText.trim()) return { finalText: rawText, status: 'skipped' };
  const budget = input.timeoutMs ?? CLEANUP_STAGE_TIMEOUT_MS;
  const deadline = Date.now() + budget;
  try {
    const admissionError = await acquireLease(input, budget);
    const outcome = await runCleanup({
      admissionError,
      engine,
      rawText,
      requestId,
      signal,
      snapshot,
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
    if (outcome.status !== 'cancelled' || input.userCancelled()) return outcome;
    // Superseded, or the native side retired the request: keep the dictation.
    return fallback(rawText, 'cancelled', outcome.attempt);
  } catch {
    // runCleanup reports failures as outcomes; an unexpected throw still
    // must not lose the transcript.
    return input.userCancelled()
      ? { reason: 'cancelled', status: 'cancelled' }
      : fallback(rawText, 'runtime-error');
  } finally {
    // Fire and forget: release waits for a pending acquire, which can hang.
    void engine.release?.(requestId).catch(() => {});
  }
}
