import { CLEANUP_PROMPT_VERSION } from '../../domain/cleanup';
import type { CleanupProvenance } from '../../domain/types';
import { digestDictionary } from './prompt';
import {
  type CleanupOutcome,
  type CleanupSnapshot,
} from './types';

export { CLEANUP_PROMPT_VERSION };

export async function createCleanupProvenance(
  snapshot: CleanupSnapshot,
  outcome: CleanupOutcome | undefined,
): Promise<CleanupProvenance> {
  const cleaned = outcome?.status === 'cleaned';
  const fallback = outcome?.status === 'fallback';
  const attempt = outcome?.attempt;
  return {
    dictionaryDigest: await digestDictionary(snapshot.dictionary)
      .catch(() => null),
    dictionaryVersion: 1,
    modelDigest: attempt?.modelDigest ?? null,
    modelId: attempt?.modelId ?? null,
    promptVersion: CLEANUP_PROMPT_VERSION,
    reason: fallback ? outcome.reason : null,
    status: fallback ? 'fallback' : cleaned ? 'cleaned' : 'skipped',
  };
}
