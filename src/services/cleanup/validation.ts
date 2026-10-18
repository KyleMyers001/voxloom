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

function preservesCapitalization(raw: string, candidate: string): boolean {
  const words = (text: string) => text.normalize('NFC').replaceAll('’', '\'')
    .match(/[\p{L}\p{M}]+(?:'[\p{L}\p{M}]+)*/gu) ?? [];
  const source = words(raw);
  const capitalized = new Set(source.filter((word) => /^\p{Lu}/u.test(word))
    .map((word) => word.toLowerCase()));
  const lowercase = (tokens: string[]) => tokens.filter((word) =>
    /^\p{Ll}/u.test(word) && capitalized.has(word.toLowerCase()));
  // Only prohibit new lowercase occurrences of a source-capitalized word.
  // This permits existing mixed-case repetitions, filler removal, contraction
  // expansion and dictionary repairs while rejecting Émilie → émilie.
  const available = new Map<string, number>();
  for (const word of lowercase(source)) {
    const key = word.toLowerCase();
    available.set(key, (available.get(key) ?? 0) + 1);
  }
  for (const word of lowercase(words(candidate))) {
    const key = word.toLowerCase();
    const remaining = available.get(key) ?? 0;
    if (remaining === 0) return false;
    available.set(key, remaining - 1);
  }
  return true;
}

function symbols(text: string): string[] {
  // Include emoji presentation/joiner/tag code points, not just pictographs:
  // retaining the people but dropping a family joiner is still a changed symbol.
  return text.normalize('NFC')
    .match(/\p{S}|\u200d|\ufe0e|\ufe0f|\u20e3|[\u{e0020}-\u{e007f}]/gu) ?? [];
}

function quotationShape(text: string): [number, boolean] {
  const characters = Array.from(text.trim().normalize('NFC'));
  const markers: number[] = [];
  characters.forEach((character, index) => {
    if (!/["'“”‘’]/u.test(character)) return;
    // Apostrophes inside words are not quotation boundaries. Keep supported
    // contraction expansion (don't → do not, I'm → I am) working.
    if (/['‘’]/u.test(character)
      && /[\p{L}\p{M}\p{N}]/u.test(characters[index - 1] ?? '')
      && /[\p{L}\p{M}\p{N}]/u.test(characters[index + 1] ?? '')) return;
    markers.push(index);
  });
  return [markers.length, markers.length >= 2
    && markers[0] === 0 && markers.at(-1) === characters.length - 1];
}

function hasUnsafeEncoding(text: string): boolean {
  // Iterate code points: paired surrogates (emoji) are valid, lone UTF-16
  // surrogates are not. Never silently repair or pass controls to OS delivery.
  for (const character of text) {
    const point = character.codePointAt(0)!;
    if ((point < 32 && point !== 9 && point !== 10 && point !== 13)
      || point === 127 || point === 0xfffd
      || (point >= 0xd800 && point <= 0xdfff)) return true;
  }
  return false;
}

export function validateCleanupOutput(
  rawText: string,
  candidate: string,
  dictionary: readonly string[] = [],
): string | null {
  if (hasUnsafeEncoding(candidate)) return null;
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
  if (!preservesCapitalization(rawText, cleaned)) return null;
  if (JSON.stringify(symbols(rawText)) !== JSON.stringify(symbols(cleaned))) return null;
  if (JSON.stringify(quotationShape(rawText)) !== JSON.stringify(quotationShape(cleaned))) return null;
  if (!preservesContent(rawText, cleaned, dictionary)) return null;
  return cleaned;
}
