import {
  anchorWordCount,
  preservesContent,
  sameMultiset,
} from './contentGuard';
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

function preservesCapitalization(raw: string, candidate: string): boolean {
  const words = (text: string) => text.normalize('NFC').replaceAll('’', '\'')
    .match(/[\p{L}\p{M}]+(?:'[\p{L}\p{M}]+)*/gu) ?? [];
  const source = words(raw);
  const keys = (pattern: RegExp) => new Set(source
    .filter((word) => pattern.test(word)).map((word) => word.toLowerCase()));
  const capitalized = keys(/^\p{Lu}/u);
  const acronyms = keys(/^\p{Lu}{2,}$/u);
  // Only prohibit new weakened occurrences of a source word: lowercase for a
  // capitalized word (Émilie → émilie), anything but all caps for an acronym
  // (MRI → Mri). This permits existing mixed-case repetitions, filler
  // removal, contraction expansion and dictionary repairs.
  const weakened = (tokens: string[]) => tokens.filter((word) => {
    const key = word.toLowerCase();
    return (/^\p{Ll}/u.test(word) && capitalized.has(key))
      || (acronyms.has(key) && word !== word.toUpperCase());
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

type QuoteMark = ['double' | 'single', number];

/**
 * Each quotation mark's kind and its position, counted in content words
 * before it, plus whether one pair wraps the whole text. Counting marks alone
 * let a moved quote pass ("Bob resigned" → Bob "resigned yesterday").
 * Straight and curly marks of one kind are interchangeable.
 */
function quotationShape(
  text: string,
  dictionary: readonly string[],
): [QuoteMark[], boolean] {
  const characters = Array.from(text.trim().normalize('NFC'));
  const marks: QuoteMark[] = quoteMarkIndices(characters).map((index) => [
    /["“”]/u.test(characters[index]) ? 'double' : 'single',
    anchorWordCount(characters.slice(0, index).join(''), dictionary),
  ]);
  return [marks, wrapsWholeText(text)];
}

/**
 * One quotation spans the whole text, ignoring trailing sentence punctuation
 * and dropped leading fillers: `um "hello there"` and `"Hello there."` match.
 */
function wrapsWholeText(text: string): boolean {
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

// A `!` ending a word: sentence-final emphasis, not a shell or markup mark.
const FINAL_BANG = /(?<=[\p{L}\p{N}"'”’)\]])!(?=$|[\s"'”’)\]])/gu;

/**
 * Markup, shell and identifier characters (`C#`, `#TODO`, `*bold*`,
 * `sudo !!`, `$HOME`, `a|b`, `x^2`) must keep their exact counts. Only one
 * sentence-final `!` after a word may be added or removed overall.
 */
function preservesSpecialMarks(raw: string, candidate: string): boolean {
  const marks = (text: string) => text.normalize('NFC').replace(FINAL_BANG, '')
    .match(/[#*^|$!]/gu) ?? [];
  const finalBangs = (text: string) =>
    text.normalize('NFC').match(FINAL_BANG)?.length ?? 0;
  return sameMultiset(marks(raw), marks(candidate))
    && Math.abs(finalBangs(raw) - finalBangs(candidate)) <= 1;
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
  if (!preservesSpecialMarks(rawText, cleaned)) return null;
  if (JSON.stringify(quotationShape(rawText, dictionary))
    !== JSON.stringify(quotationShape(cleaned, dictionary))) return null;
  if (!preservesContent(rawText, cleaned, dictionary)) return null;
  return cleaned;
}
