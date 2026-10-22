import { preservesContent, sameMultiset } from './contentGuard';
import { preservesMarks } from './marks';
import { isDroppableFiller, quoteMarkIndices } from './tokens';

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

/**
 * Protected values, except that an exact all-letter dictionary spelling
 * (StupidJargon, WhisperKit) is the join or repair the content guard checks,
 * not a technical value: the output may add one. One the speaker already
 * said must still survive with its exact spelling.
 */
function preservesProtectedValues(
  raw: string,
  candidate: string,
  dictionary: readonly string[],
): boolean {
  const spellings = new Set(dictionary.map((term) => term.trim().normalize('NFC'))
    .filter((term) => /^[\p{L}\p{M}]+$/u.test(term)));
  const source = protectedValues(raw);
  const output = protectedValues(candidate);
  const left = output.filter((value) => spellings.has(value));
  for (const value of source.filter((term) => spellings.has(term))) {
    const index = left.indexOf(value);
    if (index < 0) return false;
    left.splice(index, 1);
  }
  return sameMultiset(
    source.filter((value) => !spellings.has(value)),
    output.filter((value) => !spellings.has(value)),
  );
}

/**
 * The output without one pair of double quotes around all of it, when the
 * transcript was not itself quoted: small models echo the prompt's JSON
 * string quotes. Partial or nested quotation is left for the guards.
 */
function unwrapQuotedOutput(raw: string, cleaned: string): string {
  if (wrapsWholeText(raw)) return cleaned;
  const pair = /^(?:"([^"“”]*)"|“([^"“”]*)”)$/u.exec(cleaned);
  const inner = (pair?.[1] ?? pair?.[2])?.trim();
  return inner || cleaned;
}

// An uppercase stem of 2+ letters, optionally plural or possessive: ER, APIs,
// CEO's (curly apostrophes are normalized first).
const ACRONYM = /^\p{Lu}{2,}(?:'?s)?$/u;

function preservesCapitalization(raw: string, candidate: string): boolean {
  const words = (text: string) => text.normalize('NFC').replaceAll('’', '\'')
    .match(/[\p{L}\p{M}]+(?:'[\p{L}\p{M}]+)*/gu) ?? [];
  const source = words(raw);
  const keys = (pattern: RegExp) => new Set(source
    .filter((word) => pattern.test(word)).map((word) => word.toLowerCase()));
  const capitalized = keys(/^\p{Lu}/u);
  const acronyms = keys(ACRONYM);
  // Only prohibit new weakened occurrences of a source word: lowercase for a
  // capitalized word (Émilie → émilie), anything but an uppercase stem for an
  // acronym (MRI → Mri, APIs → Apis). This permits existing mixed-case repetitions, filler
  // removal, contraction expansion and dictionary repairs.
  const weakened = (tokens: string[]) => tokens.filter((word) => {
    const key = word.toLowerCase();
    return (/^\p{Ll}/u.test(word) && capitalized.has(key))
      || (acronyms.has(key) && !ACRONYM.test(word));
  });
  const available = new Map<string, number>();
  for (const word of weakened(source)) {
    const key = word.toLowerCase();
    available.set(key, (available.get(key) ?? 0) + 1);
  }
  for (const word of weakened(words(candidate))) {
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

/**
 * One quotation spans the whole text, ignoring trailing sentence punctuation
 * and dropped leading fillers: `um "hello there"` and `"Hello there."` match.
 */
export function wrapsWholeText(text: string): boolean {
  let core = text.trim().normalize('NFC');
  for (;;) {
    const lead = /^([\p{L}]+)[\s,.…]+/u.exec(core);
    if (!lead || !isDroppableFiller(lead[1], true)) break;
    core = core.slice(lead[0].length);
  }
  core = core.replace(/[\s.,!?;:…。！？]+$/u, '');
  const characters = Array.from(core);
  const indices = quoteMarkIndices(characters);
  return indices.length >= 2
    && indices[0] === 0 && indices.at(-1) === characters.length - 1;
}

/**
 * Leaked model reasoning (`<think>`, `reasoning:`). Only markers the speaker
 * did not dictate count, so `my reasoning: it is cheap` can still be cleaned.
 */
function reasoningMarkers(text: string): number {
  return text.normalize('NFC').match(/<\/?think>|reasoning:/giu)?.length ?? 0;
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
  const cleaned = unwrapQuotedOutput(rawText, candidate.trim());
  if (!cleaned) return null;
  if (encoder.encode(cleaned).byteLength > CLEANUP_OUTPUT_MAX_BYTES) {
    return null;
  }
  const maxChars = rawText.length * CLEANUP_OUTPUT_EXPANSION
    + CLEANUP_OUTPUT_EXTRA_CHARS;
  if (cleaned.length > maxChars) return null;
  if (reasoningMarkers(cleaned) > reasoningMarkers(rawText)) return null;
  if (!preservesProtectedValues(rawText, cleaned, dictionary)) return null;
  if (!preservesCapitalization(rawText, cleaned)) return null;
  if (JSON.stringify(symbols(rawText)) !== JSON.stringify(symbols(cleaned))) return null;
  if (!preservesMarks(rawText, cleaned, dictionary)) return null;
  if (wrapsWholeText(rawText) !== wrapsWholeText(cleaned)) return null;
  if (!preservesContent(rawText, cleaned, dictionary)) return null;
  return cleaned;
}
