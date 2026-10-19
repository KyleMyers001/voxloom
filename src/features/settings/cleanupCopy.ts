/** BUS-16 PR 2c: Settings copy for local cleanup (pending UI/UX review). */
import type { CleanupModelStatus } from '../../services/cleanup/types';

export const CLEANUP_LABEL = 'Local cleanup';
export const CLEANUP_TAG = 'Experimental';
export const CLEANUP_HELP =
  'Fixes punctuation and drops filler words on this Mac. If cleanup fails or changes your words, Voxloom types what you said.';
export const CLEANUP_SWITCH = 'Clean up transcripts locally';
export const CLEANUP_MODEL_LABEL = 'Cleanup model';
export const CLEANUP_IMPORT = 'Import model…';
export const CLEANUP_IMPORTING = 'Importing…';
export const CLEANUP_REFRESH = 'Check again';

/** Ends a reason with a period unless it already ends in . ! or ? (no ".."). */
export function endSentence(reason: string): string {
  const trimmed = reason.trimEnd();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export type CleanupModelView =
  | { kind: 'browser' }
  | { kind: 'checking' }
  | { kind: 'error'; message: string }
  | { kind: 'status'; status: CleanupModelStatus };

export function cleanupModelNote(view: CleanupModelView): string {
  if (view.kind === 'browser') return 'Available in the desktop app.';
  if (view.kind === 'checking') return 'Checking the cleanup model…';
  if (view.kind === 'error') return `Couldn't check the cleanup model: ${endSentence(view.message)}`;
  const { status } = view;
  if (!status.available) return 'Not installed. Import the Qwen3 0.6B (Q4_K_M) GGUF file.';
  if (!status.runtimeAvailable) {
    // Only reachable in dev builds: production hides the block without a worker.
    return 'Model installed. This build doesn\'t include the cleanup worker yet.';
  }
  return 'Qwen3 0.6B is installed.';
}

/** BUS-101: import failures use their own line, not the check-failure note. */
export function cleanupImportNote(reason: string, modelInstalled: boolean): string {
  const base = `Couldn't import that file: ${endSentence(reason)}`;
  return modelInstalled ? `${base} Your current model is unchanged.` : base;
}

/** Cleanup can be turned on only with a verified model and a worker. */
export function cleanupReady(view: CleanupModelView): view is { kind: 'status'; status: CleanupModelStatus } {
  return view.kind === 'status' && view.status.available && view.status.runtimeAvailable;
}
