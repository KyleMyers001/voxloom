import type { WritingStyle } from '../../domain/types';

export const CLEANUP_MODEL_ID = 'qwen3-0.6b-q4-k-m' as const;
export const CLEANUP_MODEL_SHA256 =
  'ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a';

export const CLEANUP_REASONS = [
  'cancelled', 'context-overflow', 'invalid-output', 'model-missing',
  'runtime-error', 'timeout',
] as const;
export type CleanupReason = typeof CLEANUP_REASONS[number];

export interface CleanupAttempt {
  modelDigest: string;
  modelId: string;
}

export interface CleanupResult {
  attempt: CleanupAttempt;
  text: string;
}

export class CleanupEngineError extends Error {
  constructor(
    readonly code: CleanupReason,
    message: string,
    readonly attempt?: CleanupAttempt,
  ) {
    super(message);
    this.name = 'CleanupEngineError';
  }
}

export interface CleanupSnapshot {
  dictionary: readonly string[];
  enabled: boolean;
  modelId: string | null;
  style: WritingStyle;
}

export type CleanupOutcome = (
  | { finalText: string; status: 'cleaned' }
  | { finalText: string; reason: CleanupReason; status: 'fallback' }
  | { finalText: string; status: 'skipped' }
  | { reason: 'cancelled'; status: 'cancelled' }
) & { attempt?: CleanupAttempt };

export interface CleanupRequest {
  dictionary: readonly string[];
  modelId: string;
  prompt: string;
  rawText: string;
  requestId: string;
  style: WritingStyle;
  /** Milliseconds left of the cleanup budget when the run starts. */
  timeLeftMs?: number;
}

export interface CleanupModelStatus {
  available: boolean;
  id: string;
  runtimeAvailable: boolean;
  sha256: string;
}
