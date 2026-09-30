import { preservesContent, sameMultiset } from './contentGuard';

export const CLEANUP_OUTPUT_MAX_BYTES = 32_000;
export const CLEANUP_OUTPUT_EXTRA_CHARS = 256;
export const CLEANUP_OUTPUT_EXPANSION = 2;

const encoder = new TextEncoder();
// Keep entire technical lexemes rather than matching their safe-looking
// substrings. Quotes/brackets and trailing sentence punctuation are wrappers;
// signs, internal punctuation, URL suffixes, and multiplicity are significant.
function protectedValues(text: string): string[] {
  const lexemes = text.normalize('NFC')
    .match(/[^\s"'“”‘’`<>(){}[\]]+/gu) ?? [];
  return lexemes.map((value) => value.replace(/[.,!?;:。！？、，；：]+$/gu, ''))
    .filter((value) => /[\p{N}_/@\\=]|[\p{L}]-[\p{L}]|^-+[\p{L}]|^[.~][\p{L}]|[\p{Ll}][\p{Lu}]|[\p{L}]\.[\p{L}]/u.test(value));
}

export function validateCleanupOutput(
  rawText: string,
  candidate: string,
  dictionary: readonly string[] = [],
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
  if (!sameMultiset(protectedValues(rawText), protectedValues(cleaned))) return null;
  if (!preservesContent(rawText, cleaned, dictionary)) return null;
  return cleaned;
}
