import type { ProcessingSignal } from '../dictation/coordinator';
import type { CleanupEngine } from './contracts';
import {
  buildCleanupPrompt,
  snapshotDictionary,
} from './prompt';
import type {
  CleanupOutcome,
  CleanupSnapshot,
} from './types';
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

function errorReason(error: unknown): 'model-missing' | 'runtime-error' {
  const message = error instanceof Error ? error.message : String(error);
  return /cleanup model|unknown cleanup model/i.test(message)
    ? 'model-missing'
    : 'runtime-error';
}

type RaceResult =
  | { kind: 'abort' }
  | { kind: 'output'; text: string }
  | { error: unknown; kind: 'error' }
  | { kind: 'timeout' };

export async function runCleanup(input: {
  engine: CleanupEngine;
  rawText: string;
  requestId: string;
  signal: ProcessingSignal;
  snapshot: CleanupSnapshot;
  timeoutMs?: number;
}): Promise<CleanupOutcome> {
  if (!input.snapshot.enabled) {
    return { finalText: input.rawText, status: 'skipped' };
  }
  if (!input.snapshot.modelId) {
    return {
      finalText: input.rawText,
      reason: 'model-missing',
      status: 'fallback',
    };
  }
  if (input.signal.aborted) {
    return { reason: 'cancelled', status: 'cancelled' };
  }

  let prompt: string;
  const dictionary = snapshotDictionary(input.snapshot.dictionary);
  try {
    prompt = buildCleanupPrompt({
      dictionary,
      rawText: input.rawText,
      style: input.snapshot.style,
    });
  } catch {
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
  const abortResult = new Promise<RaceResult>((resolve) => {
    input.signal.onAbort(() => resolve({ kind: 'abort' }));
  });
  const inference = input.engine.run({
    dictionary,
    modelId: input.snapshot.modelId,
    prompt,
    rawText: input.rawText,
    requestId: input.requestId,
    style: input.snapshot.style,
  }).then(
    (text): RaceResult => ({ kind: 'output', text }),
    (error: unknown): RaceResult => ({ error, kind: 'error' }),
  );
  const result = await Promise.race([
    inference,
    timeoutResult,
    abortResult,
  ]);
  if (timeout !== undefined) clearTimeout(timeout);

  if (result.kind === 'abort' || input.signal.aborted) {
    await cancelSafely(input.engine, input.requestId);
    return { reason: 'cancelled', status: 'cancelled' };
  }
  if (result.kind === 'timeout') {
    await cancelSafely(input.engine, input.requestId);
    return {
      finalText: input.rawText,
      reason: 'timeout',
      status: 'fallback',
    };
  }
  if (result.kind === 'error') {
    return {
      finalText: input.rawText,
      reason: errorReason(result.error),
      status: 'fallback',
    };
  }
  const finalText = validateCleanupOutput(input.rawText, result.text);
  return finalText
    ? { finalText, status: 'cleaned' }
    : {
        finalText: input.rawText,
        reason: 'invalid-output',
        status: 'fallback',
      };
}
