import type { DictationState } from '../../domain/types';

/** Overlay is visible only while listening or processing (AC4). */
export function isOverlayVisible(kind: DictationState['kind']): boolean {
  return kind === 'listening' || kind === 'processing';
}

export type OverlayWaveform =
  | 'silent'
  | 'speaking'
  | 'processing'
  /** Transient result states (HUD rules 4–5), emitted by overlayBridge after delivery. */
  | 'result-copied'
  | 'result-failed'
  | 'result-unverified';

/**
 * What the HUD shows after a gesture run. Inserted and cancelled show nothing.
 * `maybe-copied`: the write could not be confirmed and the text was also copied.
 * `unverified`: sent to Terminal, not confirmed and not copied.
 */
export type OverlayResult =
  | 'copied'
  | 'maybe-copied'
  | 'unverified'
  | 'insert-failed'
  | 'transcribe-failed';

/** Review: every result holds ~2.5 s (Copied was 1.5 s, too short to read). */
export const RESULT_HOLD_MS: Record<OverlayResult, number> = {
  copied: 2500,
  'insert-failed': 2500,
  'maybe-copied': 2500,
  'transcribe-failed': 2500,
  unverified: 2500,
};

export function resultWaveform(result: OverlayResult): OverlayWaveform {
  if (result === 'copied' || result === 'maybe-copied') return 'result-copied';
  if (result === 'unverified') return 'result-unverified';
  return 'result-failed';
}

export function overlayWaveformFromDictation(
  dictation: DictationState,
): OverlayWaveform | null {
  if (dictation.kind === 'listening') return dictation.waveform;
  if (dictation.kind === 'processing') return 'processing';
  return null;
}
