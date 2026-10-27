/// Optional local LLM cleanup between STT and delivery (BUS-16 PR 2c).
/// It never throws and never loses the transcript: a failure, timeout,
/// native abort or validator reject falls back to the raw text. Only the
/// user's own cancel returns `cancelled`, which delivers nothing, as a cancel
/// during transcription already does.

import type { CleanupEngine } from '../cleanup/contracts';
import { CLEANUP_BUDGET_MS, tooLongToClean } from '../cleanup/budget';
import { runCleanup } from '../cleanup/runCleanup';
import {
  CleanupEngineError,
  type CleanupOutcome,
  type CleanupSnapshot,
} from '../cleanup/types';
import type { ProcessingSignal } from './signal';

/**
 * Lease plus run, end to end (BUS-16 3c-2c): the shared cleanup budget. The
 * lease may hash the model file first, and the run re-hashes it before the
 * worker starts; both come out of this one budget.
 */
export const CLEANUP_STAGE_TIMEOUT_MS = CLEANUP_BUDGET_MS;

export interface CleanupStageInput {
  engine: CleanupEngine;
  rawText: string;
  requestId: string;
  /** Aborted by the user's cancel or by a newer dictation superseding this one. */
  signal: ProcessingSignal;
  snapshot: CleanupSnapshot;
  /** Monotonic milliseconds for the shared deadline (tests inject one). */
  now?: () => number;
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
  reason: 'cancelled' | 'context-overflow' | 'runtime-error',
  attempt?: CleanupOutcome['attempt'],
): CleanupOutcome {
  return { ...(attempt ? { attempt } : {}), finalText: rawText, reason, status: 'fallback' };
}

/**
 * The outcome of a cancel that is already in: nothing to deliver after the
 * user's own cancel, the raw text when only a newer dictation superseded this
 * one (the same as a cancel that lands in the lease or the run).
 */
function cancelledBeforeStart(
  input: CleanupStageInput,
): CleanupOutcome | undefined {
  if (input.userCancelled()) return { reason: 'cancelled', status: 'cancelled' };
  return input.signal.aborted ? fallback(input.rawText, 'cancelled') : undefined;
}

export async function cleanTranscript(input: CleanupStageInput): Promise<CleanupOutcome> {
  const { engine, rawText, requestId, signal, snapshot } = input;
  if (!snapshot.enabled || !rawText.trim()) return { finalText: rawText, status: 'skipped' };
  // Too long for the budget: raw at once, with no lease, hash or worker. The
  // history row already says "too long to clean up" for this reason. A
  // cancel that is already in comes first (BUS-122).
  if (tooLongToClean(rawText)) {
    return cancelledBeforeStart(input) ?? fallback(rawText, 'context-overflow');
  }
  const budget = input.timeoutMs ?? CLEANUP_STAGE_TIMEOUT_MS;
  // A monotonic clock: a wall-clock step must not move the deadline (BUS-123).
  const now = input.now ?? (() => performance.now());
  const deadline = now() + budget;
  try {
    const admissionError = await acquireLease(input, budget);
    const outcome = await runCleanup({
      admissionError,
      engine,
      rawText,
      requestId,
      signal,
      snapshot,
      // Whole milliseconds: native reads this as a u64 and rejects fractions.
      timeoutMs: Math.max(1, Math.floor(deadline - now())),
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
    // A synchronous throw must not replace the outcome either.
    void Promise.resolve().then(() => engine.release?.(requestId)).catch(() => {});
  }
}
