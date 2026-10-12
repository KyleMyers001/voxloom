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
  | 'result-failed';

/** What the HUD shows after a gesture run. Inserted / unverified / cancelled show nothing. */
export type OverlayResult = 'copied' | 'insert-failed' | 'transcribe-failed';

/** HUD rule 4: Copied ~1.5 s. Rule 5: failure ~2.5 s. */
export const RESULT_HOLD_MS: Record<OverlayResult, number> = {
  copied: 1500,
  'insert-failed': 2500,
  'transcribe-failed': 2500,
};

export function resultWaveform(result: OverlayResult): OverlayWaveform {
  return result === 'copied' ? 'result-copied' : 'result-failed';
}

export function overlayWaveformFromDictation(
  dictation: DictationState,
): OverlayWaveform | null {
  if (dictation.kind === 'listening') return dictation.waveform;
  if (dictation.kind === 'processing') return 'processing';
  return null;
}
