import type { CleanupProvenance } from './types';

/**
 * Prompt contract version recorded on every new history row (BUS-16). The
 * cleanup service and skipped dogfood rows share it so one build never
 * writes two versions for the same prompt.
 */
export const CLEANUP_PROMPT_VERSION = 'cleanup-v2';

/** Provenance for a row whose transcript did not go through model cleanup. */
export function skippedCleanupProvenance(): CleanupProvenance {
  return {
    dictionaryDigest: null,
    dictionaryVersion: 1,
    modelDigest: null,
    modelId: null,
    promptVersion: CLEANUP_PROMPT_VERSION,
    reason: null,
    status: 'skipped',
  };
}
