import type { ClipboardAdapter } from "../clipboard";

/**
 * Copy-before-insert sink (ADR / BUS-10).
 * Writes transcript text via ClipboardAdapter only; no insert / gesture.
 */
export async function copyTranscriptToClipboard(
  text: string,
  clipboard: ClipboardAdapter,
): Promise<void> {
  await clipboard.copy(text);
}
