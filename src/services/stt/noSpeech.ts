/// BUS-23: truthful status when native cleanup leaves nothing to deliver.
/// Delivery already refuses blank text (no insert, clipboard untouched);
/// this only replaces the generic "empty transcript" wording.

import { deliveryMessage, type DeliveryOutcome } from '../delivery';
import type { Transcript, TranscriptDropReason } from './types';

const REASONS: Record<TranscriptDropReason, string> = {
  'no-speech': 'no speech detected',
  'non-speech-only': 'only background sounds detected',
  'quiet-hallucination': 'no speech detected',
  'silent-audio': 'no speech detected (silent audio)',
};

export function noSpeechDetail(transcript: Transcript): string | null {
  if (transcript.text.trim() !== '') return null;
  const reason = transcript.dropped ? REASONS[transcript.dropped] : null;
  return reason ? `${reason}; nothing inserted or copied` : null;
}

/** Reword a blank-transcript outcome; any other outcome is returned as-is. */
export function explainEmptyTranscript(
  outcome: DeliveryOutcome,
  transcript: Transcript,
): DeliveryOutcome {
  const detail = noSpeechDetail(transcript);
  if (!detail || outcome.status !== 'failed') return outcome;
  return {
    ...outcome,
    detail,
    message: deliveryMessage('failed', detail),
  };
}
