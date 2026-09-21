import type { DictationRecord, HistoryStatus, WritingStyle } from "./types";

interface RecordInput {
  id: string;
  now: number;
  style: WritingStyle;
}

/** Inputs for a session history row from the dogfood Dictate path. */
export interface DogfoodRecordInput {
  /** True when the Copy sink wrote successfully. */
  copied: boolean;
  /** Capture duration in milliseconds (converted to whole seconds). */
  durationMs: number;
  id: string;
  now: number;
  style: WritingStyle;
  text: string;
}

export function canRetry(record: DictationRecord, now: number): boolean {
  return record.status === "failed" && record.recoveryExpiresAt !== null &&
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
    recoveryExpiresAt: now + 10 * 60_000,
    status: "failed",
    style,
    text: "Transcription failed before insertion.",
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
    recoveryExpiresAt: null,
    status: "inserted",
    style,
    text: "Keep the TypeScript boundary small and explicit.",
  };
}

/**
 * Build a session History row after dogfood STT (+ optional Copy).
 * Returns null for blank/whitespace transcripts so we never pollute
 * Recent / History with fake success rows (blank-audio flakes).
 *
 * Status is honest about delivery:
 * - `copied` when clipboard write succeeded
 * - `failed` when STT produced text but Copy soft-failed (text retained)
 */
export function createDogfoodRecord(
  input: DogfoodRecordInput,
): DictationRecord | null {
  const text = input.text.trim();
  if (!text) return null;

  const status: HistoryStatus = input.copied ? "copied" : "failed";
  const durationSeconds = Math.max(0, Math.round(input.durationMs / 1_000));

  return {
    createdAt: input.now,
    durationSeconds,
    id: input.id,
    recoveryExpiresAt: status === "failed" ? input.now + 10 * 60_000 : null,
    status,
    style: input.style,
    text,
  };
}
