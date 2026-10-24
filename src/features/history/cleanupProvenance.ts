/** BUS-16 PR 2c: History copy for cleanup provenance (UI/UX approved). */
import type { CleanupProvenance } from '../../domain/types';

const FALLBACK_REASONS: ReadonlyMap<string, string> = new Map([
  ['cancelled', 'cleanup was interrupted'],
  ['context-overflow', 'too long to clean up'],
  ['invalid-output', 'cleanup changed your words'],
  ['model-missing', 'cleanup model missing'],
  ['runtime-error', 'cleanup failed'],
  ['timeout', 'cleanup timed out'],
  // BUS-135: a build without the cleanup worker. Not a failure: cleanup stays
  // on and resumes once a build with the worker is installed.
  ['worker-missing', 'cleanup unavailable'],
]);

/**
 * One meta label for a row's cleanup, or null when cleanup never ran
 * (skipped, legacy rows, unreadable provenance): those rows are raw text.
 */
export function cleanupLabel(cleanup: CleanupProvenance | undefined): string | null {
  if (cleanup?.status === 'cleaned') return 'Cleaned up locally';
  if (cleanup?.status !== 'fallback') return null;
  // A Map, so a stored reason like `constructor` can't hit Object.prototype.
  const reason = (cleanup.reason && FALLBACK_REASONS.get(cleanup.reason)) || 'cleanup failed';
  return `Original kept · ${reason}`;
}
