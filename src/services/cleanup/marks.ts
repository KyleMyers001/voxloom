import { anchorCounts } from './contentGuard';
import { scanQuotes, utf16Offsets } from './tokens';

// Sentence punctuation cleanup may add, drop or change. Quotation marks are
// compared by position separately; sentence-final `!` and `！` share a budget.
const SENTENCE_PUNCTUATION = /[.,?;:…—–。，、？；：]/u;
const QUOTE = /["'“”‘’]/u;
const UNCOUNTED = /[\p{L}\p{M}\p{N}\s]/u;

/** A `!` ending a word, or a full-width `！`: emphasis, not a shell mark. */
function isEmphasisBang(characters: readonly string[], index: number): boolean {
  if (characters[index] === '！') return true;
  return characters[index] === '!'
    && /[\p{L}\p{N}"'”’)\]]/u.test(characters[index - 1] ?? '')
    && /^$|[\s"'”’)\]]/u.test(characters[index + 1] ?? '');
}

/** An en dash in a numeric range (`5 – 10`) is content, not punctuation. */
function isRangeDash(characters: readonly string[], index: number): boolean {
  if (characters[index] !== '–') return false;
  const nearest = (step: number) => {
    let at = index + step;
    while (/\s/u.test(characters[at] ?? '')) at += step;
    return characters[at] ?? '';
  };
  return /\p{N}/u.test(nearest(-1)) && /\p{N}/u.test(nearest(1));
}

/** Not a letter, digit, whitespace, quotation mark or sentence punctuation. */
function isCountedMark(characters: readonly string[], index: number): boolean {
  const character = characters[index];
  if (UNCOUNTED.test(character) || QUOTE.test(character)) return false;
  return !SENTENCE_PUNCTUATION.test(character) || isRangeDash(characters, index);
}

type Mark = [string, number];

/**
 * Counted marks in order, each with the content words before it (fillers
 * and articles are not counted, as for quotation marks), plus the number of
 * emphasis bangs.
 */
function countedMarks(text: string, dictionary: readonly string[]): [Mark[], number] {
  const normalized = text.normalize('NFC');
  const characters = Array.from(normalized);
  const apostrophes = new Set(scanQuotes(characters).apostrophes);
  const marks: string[] = [];
  const indices: number[] = [];
  let bangs = 0;
  characters.forEach((character, index) => {
    if (isEmphasisBang(characters, index)) {
      bangs++;
      return;
    }
    const apostrophe = apostrophes.has(index);
    if (!apostrophe && !isCountedMark(characters, index)) return;
    marks.push(apostrophe ? '\'' : character);
    indices.push(index);
  });
  const offsets = utf16Offsets(characters);
  const anchors = anchorCounts(
    normalized, indices.map((index) => offsets[index]), dictionary,
  );
  return [marks.map((mark, at) => [mark, anchors[at]]), bangs];
}

/**
 * Every character that is not a letter, digit, whitespace, quotation mark or
 * sentence punctuation (`&&`, `C#`, `*bold*`, `$HOME`, `a|b`, `(x)`, `§`,
 * `5 – 10`) and every apostrophe outside a word (`boys'`, `'90s`) must stay
 * in order between the same content words, so `C# and F` → `C and F#` fails.
 * Only one sentence-final `!` or `！` may be added or removed overall.
 */
export function preservesMarks(
  raw: string,
  candidate: string,
  dictionary: readonly string[],
): boolean {
  const [rawMarks, rawBangs] = countedMarks(raw, dictionary);
  const [candidateMarks, candidateBangs] = countedMarks(candidate, dictionary);
  return JSON.stringify(rawMarks) === JSON.stringify(candidateMarks)
    && Math.abs(rawBangs - candidateBangs) <= 1;
}
