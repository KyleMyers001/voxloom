import type { ClipboardAdapter } from '../clipboard';
import type { Transcript } from './types';

/**
 * Copy-before-insert sink (ADR / BUS-10).
 * Writes transcript text via ClipboardAdapter only; no insert / gesture.
 * Prefer `deliverTranscript` in `services/delivery` (BUS-14) for insert +
 * truthful fallback. Policy: docs/decisions/native-shortcut-cancel-focus.md §§4–5.
 */
export async function copyTranscriptToClipboard(
  text: string,
  clipboard: ClipboardAdapter,
): Promise<void> {
  await clipboard.copy(text);
}

/**
 * Convenience: copy a Transcript through the Copy sink.
 * Prefer `deliverTranscript` (BUS-14); this sink remains the Copy floor.
 */
export async function copyTranscript(
  transcript: Transcript,
  clipboard: ClipboardAdapter,
): Promise<void> {
  await copyTranscriptToClipboard(transcript.text, clipboard);
}
