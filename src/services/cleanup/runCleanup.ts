import type { ProcessingSignal } from '../dictation/signal';
import type { CleanupEngine } from './contracts';
import {
  buildCleanupPrompt,
  snapshotDictionary,
} from './prompt';
import type {
  CleanupAttempt,
  CleanupOutcome,
  CleanupSnapshot,
} from './types';
import { CleanupEngineError } from './types';
import { validateCleanupOutput } from './validation';

const DEFAULT_TIMEOUT_MS = 30_000;

async function cancelSafely(
  engine: CleanupEngine,
  requestId: string,
): Promise<void> {
  try {
    await engine.cancel(requestId);
  } catch {
    // Cancellation still forbids delivery if teardown reports an error.
  }
}

function errorReason(error: unknown) {
  return error instanceof CleanupEngineError
    ? error.code
    : 'runtime-error' as const;
}

type RaceResult =
  | { kind: 'abort' }
  | { kind: 'output'; text: string }
  | { error: unknown; kind: 'error' }
  | { kind: 'timeout' };

export async function runCleanup(input: {
  admissionError?: CleanupEngineError;
  engine: CleanupEngine;
  onStarted?: () => void;
  rawText: string;
  requestId: string;
  signal: ProcessingSignal;
  snapshot: CleanupSnapshot;
  timeoutMs?: number;
}): Promise<CleanupOutcome> {
  if (input.signal.aborted || input.admissionError?.code === 'cancelled') {
    return { reason: 'cancelled', status: 'cancelled' };
  }
  if (!input.snapshot.enabled) {
    return { finalText: input.rawText, status: 'skipped' };
  }
  if (input.admissionError) {
    return { finalText: input.rawText, reason: input.admissionError.code, status: 'fallback' };
  }
  const modelId = input.snapshot.modelId;
  if (!modelId) {
    return {
      finalText: input.rawText,
      reason: 'model-missing',
      status: 'fallback',
    };
  }
  let attempt: CleanupAttempt | undefined;
  let listening = true;
  let announced = false;
  const withAttempt = (outcome: CleanupOutcome): CleanupOutcome =>
    attempt ? { ...outcome, attempt } : outcome;
  let prompt: string;
  const dictionary = snapshotDictionary(input.snapshot.dictionary);
  try {
    prompt = buildCleanupPrompt({
      dictionary,
      rawText: input.rawText,
      style: input.snapshot.style,
    });
  } catch {
    await cancelSafely(input.engine, input.requestId);
    if (input.signal.aborted) return { reason: 'cancelled', status: 'cancelled' };
    return {
      finalText: input.rawText,
      reason: 'context-overflow',
      status: 'fallback',
    };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<RaceResult>((resolve) => {
    timeout = setTimeout(
      () => resolve({ kind: 'timeout' }),
      input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  });
  let stopListening = (): void => {};
  const abortResult = new Promise<RaceResult>((resolve) => {
    stopListening = input.signal.onAbort(() => resolve({ kind: 'abort' }))
      ?? stopListening;
  });
  const inference = (async () => input.engine.run({
    dictionary,
    modelId,
    prompt,
    rawText: input.rawText,
    requestId: input.requestId,
    style: input.snapshot.style,
  }, (evidence) => {
    if (!listening) return;
    attempt = evidence;
    if (!announced && !input.signal.aborted) {
      announced = true;
      input.onStarted?.();
    }
  }))().then(
    (output): RaceResult => {
      if (typeof output !== 'string') attempt = output.attempt;
      return { kind: 'output', text: typeof output === 'string' ? output : output.text };
    },
    (error: unknown): RaceResult => {
      if (error instanceof CleanupEngineError && error.attempt) attempt = error.attempt;
      return { error, kind: 'error' };
    },
  );
  const result = await Promise.race([
    inference,
    timeoutResult,
    abortResult,
  ]);
  listening = false;
  if (timeout !== undefined) clearTimeout(timeout);
  stopListening();

  if (result.kind === 'abort' || input.signal.aborted) {
    await cancelSafely(input.engine, input.requestId);
    return withAttempt({ reason: 'cancelled', status: 'cancelled' });
  }
  if (result.kind === 'timeout') {
    await cancelSafely(input.engine, input.requestId);
    if (input.signal.aborted) return withAttempt({ reason: 'cancelled', status: 'cancelled' });
    return withAttempt({
      finalText: input.rawText,
      reason: 'timeout',
      status: 'fallback',
    });
  }
  if (result.kind === 'error') {
    if (errorReason(result.error) === 'cancelled') {
      return withAttempt({ reason: 'cancelled', status: 'cancelled' });
    }
    return withAttempt({
      finalText: input.rawText,
      reason: errorReason(result.error),
      status: 'fallback',
    });
  }
  const finalText = validateCleanupOutput(input.rawText, result.text, dictionary);
  return withAttempt(finalText
    ? { finalText, status: 'cleaned' }
    : {
        finalText: input.rawText,
        reason: 'invalid-output',
        status: 'fallback',
      });
}
