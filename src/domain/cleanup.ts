import type { CleanupProvenance, Settings } from './types';

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

/**
 * Cleanup runs only when the explicit opt-in that the Settings UI writes is
 * set (Sophie's single-key call). `cleanupEnabled` is a legacy key: still
 * loaded and saved, but ignored here, so a #24-era file that has it without
 * the opt-in stays off.
 */
export function isCleanupActive(settings: Pick<Settings, 'cleanupOptIn'>): boolean {
  return settings.cleanupOptIn === true;
}
