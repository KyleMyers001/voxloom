import { skippedCleanupProvenance } from './cleanup';
import type {
  CleanupProvenance,
  DictationRecord,
  HistoryStatus,
  WritingStyle,
} from './types';

interface RecordInput {
  id: string;
  now: number;
  style: WritingStyle;
}

/** Inputs for a session history row from the dogfood Dictate path. */
export interface DogfoodRecordInput {
  cleanup?: CleanupProvenance;
  /**
   * Evidence-backed delivery status (BUS-14).
   * Prefer `status` when present; legacy `copied` boolean still accepted.
   */
  status?: HistoryStatus;
  /** Delivery may have inserted the text; recorded as `unverified`, never Failed/Copied. */
  mayHaveInserted?: boolean;
  /** @deprecated Prefer `status`. True when Copy sink wrote successfully. */
  copied?: boolean;
  /** Capture duration in milliseconds (converted to whole seconds). */
  durationMs: number;
  id: string;
  /** STT model id used for this transcript, when known. */
  model?: string | null;
  now: number;
  /** Raw engine output before deterministic and optional model cleanup. */
  rawText?: string;
  style: WritingStyle;
  text: string;
}

export function canRetry(record: DictationRecord, now: number): boolean {
  return record.status === 'failed' && record.recoveryExpiresAt !== null &&
    record.recoveryExpiresAt > now;
}

export function createFailedRecord({
  id,
  now,
  style,
}: RecordInput): DictationRecord {
  return {
    createdAt: now,
    durationSeconds: 12,
    id,
    model: null,
    recoveryExpiresAt: now + 10 * 60_000,
    status: 'failed',
    style,
    text: 'Transcription failed before insertion.',
  };
}

export function createSuccessfulRecord({
  id,
  now,
  style,
}: RecordInput): DictationRecord {
  return {
    createdAt: now,
    durationSeconds: 12,
    id,
    model: null,
    recoveryExpiresAt: null,
    status: 'inserted',
    style,
    text: 'Keep the TypeScript boundary small and explicit.',
  };
}

/**
 * Build a History row after dogfood STT + delivery.
 * Returns null for blank/whitespace transcripts so we never pollute
 * Recent / History with fake success rows (blank-audio flakes).
 *
 * Status is honest about delivery evidence (BUS-14):
 * - `inserted` when AX/platform insert completed
 * - `copied` when clipboard write succeeded as fallback
 * - `failed` when STT produced text but delivery soft-failed (text retained)
 */
export function createDogfoodRecord(
  input: DogfoodRecordInput,
): DictationRecord | null {
  const text = input.text.trim();
  if (!text) return null;

  let status: HistoryStatus;
  const maybe = input.mayHaveInserted === true;
  if (maybe) {
    status = 'unverified';
  } else if (input.status) {
    status = input.status;
  } else if (input.copied === true) {
    status = 'copied';
  } else {
    status = 'failed';
  }

  const durationSeconds = Math.max(0, Math.round(input.durationMs / 1_000));
  const rawText = input.rawText?.trim();

  return {
    cleanup: input.cleanup ?? skippedCleanupProvenance(),
    createdAt: input.now,
    durationSeconds,
    id: input.id,
    model: input.model ?? null,
    ...(maybe ? { mayHaveInserted: { copied: input.status === 'copied' } } : {}),
    rawText: rawText || text,
    // STT/delivery failures retain text, never a replayable audio buffer.
    recoveryExpiresAt: null,
    status,
    style: input.style,
    text,
  };
}
