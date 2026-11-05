/// Exact-letter joins (BUS-138 PR B2): a dictionary word heard as two or three
/// words whose letters spell it exactly ("vox loom", "vox-loom" for Voxloom).
/// Runs with or without cleanup. It only joins what the entry spells out: no
/// sound-alike guessing, that is the cleanup model's job.

import { isGuardedWord } from '../cleanup/guardedWords';
import { endsCleanly, startsInsideWord } from './boundary';
import { touchesCode } from './codeContext';
import { isCommonWord } from './commonWords';

const WORDS = /[\p{L}\p{M}\p{N}_]+/gu;
const MAX_WORDS = 3;
/** One letter is no word to join: "e bay" is not eBay. */
const PIECE = /^[\p{L}\p{M}]{2,}$/u;
const MIN_LETTERS = 5;
// Only spaces, tabs or one hyphen between the words, never sentence
// punctuation or a line break.
const GAP = /^(?:[^\S\r\n]+|-)$/u;

// Final sigma: "ΠΑΎΛΟΥΣ" lowercases to ς at the end of a word but σ inside one,
// so both sides of a lookup are folded to σ.
export const foldKey = (spelled: string) =>
  spelled.replace(/[\s-]+/gu, '').toLowerCase().replace(/ς/gu, 'σ');

interface Word {
  end: number;
  start: number;
  text: string;
}

function isRun(text: string, run: readonly Word[]): boolean {
  const joined = run.map((word) => word.text).join('');
  return run.every((word) => PIECE.test(word.text))
    && joined.length >= MIN_LETTERS
    // Plain common words together ("any one", "to day") are never one word.
    && !run.every((word) => isCommonWord(word.text))
    // "not ion", "no tion", "I on" change what was said if joined.
    && !run.some((word) => isGuardedWord(word.text))
    && run.every((word, index) => index === 0
      || GAP.test(text.slice(run[index - 1].end, word.start)));
}

const HYPHEN_THEN_LETTER = /^-[\p{L}\p{M}\p{N}]/u;

/**
 * Inside inline or fenced code. Backtick runs pair up by length, as in
 * CommonMark: a run opens a span, the next run of the same length closes it,
 * runs of other lengths inside are text. An opener never closed counts as
 * code to the end, which leaves the rest alone.
 */
function inCode(text: string, start: number): boolean {
  let open = 0;
  for (const run of text.slice(0, start).matchAll(/`+/gu)) {
    if (open === 0) open = run[0].length;
    else if (run[0].length === open) open = 0;
  }
  return open !== 0;
}

/**
 * A flag (--vox-loom), path, URL, identifier (vox-loom-cli), code in
 * backticks, or the middle of a word.
 */
function isSeparateText(text: string, start: number, end: number): boolean {
  return text[start - 1] !== '-'
    && !HYPHEN_THEN_LETTER.test(text.slice(end, end + 2))
    && !inCode(text, start)
    && !startsInsideWord(text[start - 1] ?? '', text[start - 2] ?? '')
    && endsCleanly(text.slice(end))
    && !touchesCode(text, start, end);
}

/**
 * `text` with each run of 2 or 3 adjacent words that spells a dictionary key
 * exactly written as the entry, longest run first. `spellings` maps the
 * folded key to the entry's exact text. Returns `text` itself if none.
 */
export function joinSplitWords(
  text: string,
  spellings: ReadonlyMap<string, string>,
): string {
  const words: Word[] = Array.from(text.matchAll(WORDS), (match) => ({
    end: match.index + match[0].length, start: match.index, text: match[0],
  }));
  let result = '';
  let cursor = 0;
  for (let at = 0; at < words.length; at++) {
    for (let size = Math.min(MAX_WORDS, words.length - at); size >= 2; size--) {
      const run = words.slice(at, at + size);
      const { start } = run[0];
      const { end } = run[size - 1];
      const spelled = spellings.get(foldKey(run.map((word) => word.text).join('')));
      if (spelled === undefined || !isRun(text, run)
        || !isSeparateText(text, start, end)) continue;
      result += text.slice(cursor, start) + spelled;
      cursor = end;
      at += size - 1;
      break;
    }
  }
  return cursor === 0 && result === '' ? text : result + text.slice(cursor);
}
