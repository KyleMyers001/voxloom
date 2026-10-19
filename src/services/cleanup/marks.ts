import { sameMultiset } from './contentGuard';
import { scanQuotes } from './tokens';

// Sentence punctuation cleanup may add, drop or change. Quotation marks are
// compared by position separately; a word-final `!` has its own budget.
const SENTENCE_PUNCTUATION = /[.,?;:…—–。，、？；：！]/u;
const QUOTE = /["'“”‘’]/u;
const UNCOUNTED = /[\p{L}\p{M}\p{N}\s]/u;

/** A `!` ending a word: sentence-final emphasis, not a shell or markup mark. */
function isFinalBang(characters: readonly string[], index: number): boolean {
  return characters[index] === '!'
    && /[\p{L}\p{N}"'”’)\]]/u.test(characters[index - 1] ?? '')
    && /^$|[\s"'”’)\]]/u.test(characters[index + 1] ?? '');
}

function countedMarks(text: string): [string[], number] {
  const characters = Array.from(text.normalize('NFC'));
  const apostrophes = new Set(scanQuotes(characters).apostrophes);
  const marks: string[] = [];
  let finalBangs = 0;
  characters.forEach((character, index) => {
    if (apostrophes.has(index)) marks.push('\'');
    else if (isFinalBang(characters, index)) finalBangs++;
    else if (!UNCOUNTED.test(character) && !QUOTE.test(character)
      && !SENTENCE_PUNCTUATION.test(character)) marks.push(character);
  });
  return [marks, finalBangs];
}

/**
 * Every character that is not a letter, digit, whitespace, quotation mark or
 * sentence punctuation (`&&`, `C#`, `*bold*`, `$HOME`, `a|b`, `(x)`, `§`)
 * must keep its exact count, as must apostrophes outside words (`boys'`,
 * `'90s`). Only one sentence-final `!` may be added or removed overall.
 */
export function preservesMarks(raw: string, candidate: string): boolean {
  const [rawMarks, rawBangs] = countedMarks(raw);
  const [candidateMarks, candidateBangs] = countedMarks(candidate);
  return sameMultiset(rawMarks, candidateMarks)
    && Math.abs(rawBangs - candidateBangs) <= 1;
}
