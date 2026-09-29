export const CLEANUP_OUTPUT_MAX_BYTES = 32_000;
export const CLEANUP_OUTPUT_EXTRA_CHARS = 256;
export const CLEANUP_OUTPUT_EXPANSION = 2;

const encoder = new TextEncoder();
const PROTECTED = [
  /https?:\/\/\S+/giu,
  /(?:^|\s)--?[a-z][\w-]*/giu,
  /(?:^|\s)(?:[./~][\w./~-]+)/gu,
  /\b\d+(?:[.,:]\d+)*\b/gu,
];

function protectedValues(text: string): string[] {
  return PROTECTED.flatMap((pattern) =>
    Array.from(text.matchAll(pattern), (match) => match[0].trim())
  );
}

export function validateCleanupOutput(
  rawText: string,
  candidate: string,
): string | null {
  const cleaned = candidate.trim();
  if (!cleaned) return null;
  if (encoder.encode(cleaned).byteLength > CLEANUP_OUTPUT_MAX_BYTES) {
    return null;
  }
  const maxChars = rawText.length * CLEANUP_OUTPUT_EXPANSION
    + CLEANUP_OUTPUT_EXTRA_CHARS;
  if (cleaned.length > maxChars) return null;
  if (/<\/?think>|reasoning:/iu.test(cleaned)) return null;
  const protectedRaw = protectedValues(rawText);
  if (protectedRaw.some((value) => !cleaned.includes(value))) return null;
  return cleaned;
}
