import type { CleanupProvenance } from '../../domain/types';
import { digestDictionary } from './prompt';
import {
  CLEANUP_MODEL_SHA256,
  type CleanupOutcome,
  type CleanupSnapshot,
} from './types';

export const CLEANUP_PROMPT_VERSION = 'cleanup-v1';

export async function createCleanupProvenance(
  snapshot: CleanupSnapshot,
  outcome: CleanupOutcome | undefined,
): Promise<CleanupProvenance> {
  const cleaned = outcome?.status === 'cleaned';
  const fallback = outcome?.status === 'fallback';
  const modelAttempted = cleaned || fallback;
  return {
    dictionaryDigest: await digestDictionary(snapshot.dictionary)
      .catch(() => null),
    dictionaryVersion: 1,
    modelDigest: modelAttempted ? CLEANUP_MODEL_SHA256 : null,
    modelId: modelAttempted ? snapshot.modelId : null,
    promptVersion: CLEANUP_PROMPT_VERSION,
    reason: fallback ? outcome.reason : null,
    status: fallback ? 'fallback' : cleaned ? 'cleaned' : 'skipped',
  };
}
