/** BUS-16 PR 2c: History copy for cleanup provenance (pending UI/UX review). */
import type { CleanupProvenance } from '../../domain/types';

const FALLBACK_REASONS: Readonly<Record<string, string>> = {
  'cancelled': 'cleanup was interrupted',
  'context-overflow': 'too long to clean up',
  'invalid-output': 'cleanup changed your words',
  'model-missing': 'cleanup model missing',
  'runtime-error': 'cleanup failed',
  'timeout': 'cleanup timed out',
};

/**
 * One meta label for a row's cleanup, or null when cleanup never ran
 * (skipped, legacy rows, unreadable provenance): those rows are raw text.
 */
export function cleanupLabel(cleanup: CleanupProvenance | undefined): string | null {
  if (cleanup?.status === 'cleaned') return 'Cleaned up locally';
  if (cleanup?.status !== 'fallback') return null;
  const reason = (cleanup.reason && FALLBACK_REASONS[cleanup.reason]) ?? 'cleanup failed';
  return `Original kept · ${reason}`;
}
