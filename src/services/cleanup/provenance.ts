import { CLEANUP_PROMPT_VERSION, cleanupPromptVersion } from '../../domain/cleanup';
import type { CleanupProvenance } from '../../domain/types';
import { digestDictionary, snapshotDictionary } from './prompt';
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
    // The version of the prompt this dictionary produces (BUS-188).
    promptVersion: cleanupPromptVersion(snapshotDictionary(snapshot.dictionary)),
    reason: fallback ? outcome.reason : null,
    status: fallback ? 'fallback' : cleaned ? 'cleaned' : 'skipped',
  };
}
