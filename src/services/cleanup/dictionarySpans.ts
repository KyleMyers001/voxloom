import { touchesCode } from '../dictionary/codeContext';
import { isCommonWord } from '../dictionary/commonWords';
import type { Token } from './tokens';

// Dictionary words in a transcript (BUS-138 PR B2). Speech recognition may
// hear a dictionary word as a similar-sounding word or split it ("box loom"
// for Voxloom), so a run of 1 to 3 adjacent source words may stand for one
// dictionary spelling. This is only a permission for the output check: the
// model decides whether to use it, and the output may keep the spoken words
// or write the exact spelling.

const MAX_SPAN_WORDS = 3;
/** Fewer joined letters than this are too short to tell apart by sound. */
const MIN_SPAN_LETTERS = 5;
/**
 * Inside a repaired run of words every word is longer than the 2 edits, so no
 * whole word (to, is, of) can be lost as one of them: "to vox loom" is not a
 * repair of "voxloom" that drops "to".
 */
const MIN_RUN_WORD_LETTERS = 3;
/** Words are joined only across spaces, tabs or one hyphen, never punctuation. */
const WORD_GAP = /^(?:[^\S\r\n]+|-)$/u;
const LETTERS = /^[\p{L}\p{M}]+$/u;

export interface DictionarySpan {
  /** The exact dictionary spelling, when the output must spell it exactly. */
  canonical?: string;
  /** Source words the span covers. */
  length: number;
  /** Lowercase key of the dictionary word. */
  word: string;
  /** The spoken words, when the span is a repair rather than an exact join. */
  spoken?: string[];
}

/** Lowercased dictionary key → its first exact spelling, as the prompt sends it. */
export function dictionarySpellings(
  dictionary: readonly string[],
): Map<string, string> {
  const spellings = new Map<string, string>();
  for (const term of dictionary) {
    const exact = term.trim().normalize('NFC');
    const key = exact.toLowerCase();
    if (/^[\p{L}\p{M}]{5,}$/u.test(key) && !spellings.has(key)) spellings.set(key, exact);
  }
  return spellings;
}

/** One edit for a 5 or 6 letter word, two for a longer one. */
function allowedEdits(key: string): number {
  return key.length >= 7 ? 2 : 1;
}

/** Whether `left` is within `max` insertions, deletions or substitutions of `right`. */
export function withinEdits(left: string, right: string, max: number): boolean {
  if (Math.abs(left.length - right.length) > max) return false;
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const next = [i];
    for (let j = 1; j <= right.length; j++) {
      next[j] = Math.min(
        row[j] + 1,
        next[j - 1] + 1,
        row[j - 1] + Number(left[i - 1] !== right[j - 1]),
      );
    }
    row = next;
  }
  return row[right.length] <= max;
}

/**
 * Only the ending differs: an inflection (notions → Notion), not a mishearing.
 * For several words, only the start differing is as bad: extra words around
 * the dictionary word (to vox loom). One word may differ at its start (phone →
 * iPhone).
 */
function onlyAnEndDiffers(joined: string, key: string, several: boolean): boolean {
  return joined.startsWith(key) || key.startsWith(joined)
    || (several && (joined.endsWith(key) || key.endsWith(joined)));
}

/** Spoken words that sit in one source word or one run: no punctuation between. */
function adjacent(text: string, run: readonly Token[]): boolean {
  return run.every((token, index) => index === 0 || token.continuesWord
    || WORD_GAP.test(text.slice(run[index - 1].end, token.start)));
}

function joinable(text: string, run: readonly Token[]): boolean {
  return run.every(({ skippable, word }) => !skippable && LETTERS.test(word))
    && adjacent(text, run);
}

/** Where the dictionary word starts at `tokens[at]`, if it does. `text` is NFC. */
export function findSpan(
  text: string,
  tokens: readonly Token[],
  at: number,
  spellings: ReadonlyMap<string, string>,
  repair: boolean,
): DictionarySpan | null {
  const runs = Array.from({ length: MAX_SPAN_WORDS }, (_, index) => index + 1)
    .filter((length) => at + length <= tokens.length)
    .map((length) => tokens.slice(at, at + length))
    .filter((run) => run.length === 1 || joinable(text, run));
  const spoken = (run: readonly Token[]) => run.map(({ word }) => word).join('');
  // An exact join (vox loom → voxloom) is a spelling of the word, longest first.
  for (const run of runs.filter((r) => r.length > 1).reverse()) {
    const key = spoken(run);
    if (!spellings.has(key)) continue;
    // One spoken word that expands to a dictionary word (can't, cannot →
    // can not) is that word as spoken, not a join that needs its spelling.
    const canonical = run.at(-1)!.continuesWord ? undefined : spellings.get(key);
    return { canonical, length: run.length, word: key };
  }
  if (!repair) return null;
  const matches: { key: string; run: Token[] }[] = [];
  for (const run of runs) {
    const joined = spoken(run);
    const [first, last] = [run[0], run.at(-1)!];
    const single = run.length === 1;
    if (joined.length < MIN_SPAN_LETTERS || !LETTERS.test(joined)) continue;
    // A plain common word is never a mishearing (sky stays sky), and neither
    // is a run made only of them.
    if (run.every(({ word }) => isCommonWord(word))) continue;
    if (!single && (run.some(({ continuesWord, word }) => continuesWord
      || word.length < MIN_RUN_WORD_LETTERS)
      || touchesCode(text, first.start, last.end))) continue;
    for (const key of spellings.keys()) {
      if (!withinEdits(joined, key, allowedEdits(key))) continue;
      if (joined !== key && onlyAnEndDiffers(joined, key, run.length > 1)) continue;
      matches.push({ key, run });
    }
  }
  // Two dictionary words match: ambiguous, so nothing is repaired.
  if (matches.length !== 1) return null;
  const { key, run } = matches[0];
  if (spoken(run) === key) return null;
  return {
    canonical: spellings.get(key), length: run.length, spoken: run.map(({ word }) => word),
    word: key,
  };
}
