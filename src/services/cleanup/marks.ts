import { anchorCounts, contentWords, type SourceWord } from './contentGuard';
import { scanQuotes, utf16Offsets } from './tokens';

// Sentence punctuation cleanup may add, drop or change; sentence-final `!`
// and `！` share a budget.
const SENTENCE_PUNCTUATION = /[.,?;:…—–。，、？；：]/u;
// Characters between a mark and its word that do not detach it: `"hi,"`.
const ATTACHMENT_GAP = /[.,?;:…。，、？；：!！]/u;
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

type Attached = SourceWord | null;
/** A mark, the content words before it, and the words it touches. */
type Mark = [string, number, Attached, Attached];

/**
 * The words directly touching each code point (no whitespace between, only
 * sentence punctuation), so `C# and` → `C #and` moves `#` off `c` onto `and`.
 * Source words carry their dictionary repair, as in preservesContent.
 */
function attachments(
  normalized: string,
  characters: readonly string[],
  dictionary: readonly string[],
  repair: boolean,
) {
  const ending = new Map<number, SourceWord>();
  const starting = new Map<number, SourceWord>();
  for (const word of contentWords(normalized, dictionary, repair)) {
    ending.set(word.end, word);
    if (!starting.has(word.start)) starting.set(word.start, word);
  }
  const offsets = utf16Offsets(characters);
  return (index: number): [Attached, Attached] => {
    let before = index - 1;
    while (before >= 0 && ATTACHMENT_GAP.test(characters[before])) before--;
    let after = index + 1;
    while (after < characters.length && ATTACHMENT_GAP.test(characters[after])) after++;
    return [
      before < 0 ? null : ending.get(offsets[before] + characters[before].length) ?? null,
      after >= characters.length ? null : starting.get(offsets[after]) ?? null,
    ];
  };
}

/** The output touches the same word: as spoken, or its exact repair. */
function sameAttachment(source: Attached, output: Attached): boolean {
  if (!source || !output) return source === output;
  return output.word === source.word || output.word === source.spoken;
}

/**
 * Quotation and counted marks in one ordered sequence, each with its anchor
 * (content words before it; dropped fillers and articles are not counted)
 * and attached words, plus the number of emphasis bangs. Straight and curly
 * quotation marks of one kind are interchangeable.
 */
function markSequence(
  text: string,
  dictionary: readonly string[],
  repair: boolean,
): [Mark[], number] {
  const normalized = text.normalize('NFC');
  const characters = Array.from(normalized);
  const { apostrophes, quotes } = scanQuotes(characters);
  const apostropheSet = new Set(apostrophes);
  const quoteSet = new Set(quotes);
  const symbols: string[] = [];
  const indices: number[] = [];
  let bangs = 0;
  characters.forEach((character, index) => {
    if (isEmphasisBang(characters, index)) {
      bangs++;
      return;
    }
    if (quoteSet.has(index)) symbols.push(/["“”]/u.test(character) ? '"' : '\'');
    else if (apostropheSet.has(index)) symbols.push('apostrophe');
    else if (isCountedMark(characters, index)) symbols.push(character);
    else return;
    indices.push(index);
  });
  const offsets = utf16Offsets(characters);
  const anchors = anchorCounts(
    normalized, indices.map((index) => offsets[index]), dictionary,
  );
  const attached = attachments(normalized, characters, dictionary, repair);
  return [symbols.map((symbol, at) => [
    symbol, anchors[at], ...attached(indices[at]),
  ]), bangs];
}

/**
 * Quotation marks, apostrophes outside words (`boys'`, `'90s`) and every
 * character that is not a letter, digit, whitespace or sentence punctuation
 * (`&&`, `C#`, `*bold*`, `$HOME`, `a|b`, `(x)`, `§`, `5 – 10`) must keep
 * their order, anchors and attached words: `C# and F` → `C and F#`,
 * `C #and F` or `"C"#` fails. Only one sentence-final `!` or `！` may be
 * added or removed overall.
 */
export function preservesMarks(
  raw: string,
  candidate: string,
  dictionary: readonly string[],
): boolean {
  const [rawMarks, rawBangs] = markSequence(raw, dictionary, true);
  const [candidateMarks, candidateBangs] = markSequence(candidate, dictionary, false);
  return rawMarks.length === candidateMarks.length
    && rawMarks.every(([symbol, anchor, before, after], at) => {
      const [outSymbol, outAnchor, outBefore, outAfter] = candidateMarks[at];
      return symbol === outSymbol && anchor === outAnchor
        && sameAttachment(before, outBefore) && sameAttachment(after, outAfter);
    })
    && Math.abs(rawBangs - candidateBangs) <= 1;
}
