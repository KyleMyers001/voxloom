import type { DictationRecord, WritingStyle } from "./types";

interface RecordInput {
  id: string;
  now: number;
  style: WritingStyle;
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
