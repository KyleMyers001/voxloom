import type { ClipboardAdapter } from "../clipboard";
import type { Transcript } from "./types";

/**
 * Copy-before-insert sink (ADR / BUS-10).
 * Writes transcript text via ClipboardAdapter only; no insert / gesture.
 * Delivery policy when insert is unavailable (target closed/secure, etc.):
 * docs/decisions/native-shortcut-cancel-focus.md (BUS-12) §§4–5.
 */
export async function copyTranscriptToClipboard(
  text: string,
  clipboard: ClipboardAdapter,
): Promise<void> {
  await clipboard.copy(text);
}

/**
 * Convenience: copy a Transcript through the Copy sink.
 * Insert / gesture delivery remains BUS-12–14.
 */
export async function copyTranscript(
  transcript: Transcript,
  clipboard: ClipboardAdapter,
): Promise<void> {
  await copyTranscriptToClipboard(transcript.text, clipboard);
}
