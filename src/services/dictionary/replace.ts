/// Deterministic dictionary spelling (BUS-138): once the transcript exists,
/// every dictionary entry is written exactly as saved wherever it was heard
/// differing only in case or in spacing/hyphens ("chat gpt" -> "ChatGPT").
/// No model, no sound-alike guessing (that is the optional aliases, later),
/// and nothing is rewritten that the entry does not spell out.

import { entryChunks } from './chunks';
import { touchesCode } from './codeContext';
import { isCommonWord } from './commonWords';

const WORD_CHAR = String.raw`[\p{L}\p{M}\p{N}_]`;
// Between two chunks: a run of spaces or tabs, or one hyphen, or nothing.
// Never a newline, comma or other punctuation.
const SEPARATOR = String.raw`(?:[^\S\r\n]+|-)?`;
// A match can't start right after an apostrophe inside a word (a letter or
// digit before it: "we're", "it\u2019s", "l'iphone"); it may end before one,
// so possessives work ("Voxloom's"), except before another contraction tail
// ("don't" is not a match for "Don"). Lookbehind is avoided on purpose: the
// start edge is a captured character that is put back and checked in
// replaceOnce.
const APOSTROPHE = /^['\u2019]$/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const END = String.raw`(?!${WORD_CHAR})(?!['\u2019](?!s(?!${WORD_CHAR}))\p{L})`;
const SEPARATORS = /[\s-]+/gu;
const SYNTAX_CHARS = /[\\^$.*+?()[\]{}|/]/gu;

interface Entry {
  chunks: string[];
  key: string;
  text: string;
}

// Final sigma: "ΠΑΎΛΟΥΣ" lowercases to ς at the end of a word but σ inside one,
// so both sides of a lookup are folded to σ.
const foldKey = (spelled: string) =>
  spelled.replace(SEPARATORS, '').toLowerCase().replace(/ς/gu, 'σ');

/**
 * Entry text the matcher reads back as itself: whitespace runs only of spaces
 * or tabs, a single hyphen between chunks, and no hyphen at either end. Other
 * entries ("--verbose", "chat - gpt") would not match their own output, so a
 * second pass would grow or rewrite them. They are left out.
 */
function readsBackAsItself(text: string): boolean {
  if (text.startsWith('-') || text.endsWith('-')) return false;
  return (text.match(SEPARATORS) ?? []).every((run) => /^(?:[^\S\r\n]+|-)$/u.test(run));
}

/**
 * A plain common word on its own ("Will", "Sky", "IT") can only be a case
 * change, and forcing it would recapitalise every ordinary use. Phrases,
 * hyphenated words and entries with digits or internal capitals are kept.
 */
function isPlainCommonWord({ chunks }: Entry): boolean {
  return chunks.length === 1 && /^\p{L}+$/u.test(chunks[0]) && isCommonWord(chunks[0]);
}

/** Usable entries, longest first. A repeated spelling keeps its first entry. */
function usableEntries(words: readonly string[]): Entry[] {
  const seen = new Set<string>();
  const entries: Entry[] = [];
  for (const word of words) {
    const chunks = entryChunks(word);
    if (chunks.length === 0) continue;
    const entry = { chunks, key: foldKey(chunks.join('')), text: word.trim().normalize('NFC') };
    if (!readsBackAsItself(entry.text) || seen.has(entry.key)) continue;
    seen.add(entry.key);
    if (!isPlainCommonWord(entry)) entries.push(entry);
  }
  return entries.sort((a, b) => b.key.length - a.key.length);
}

function matcherFor(entries: readonly Entry[]): RegExp {
  const alternatives = entries.map(({ chunks }) =>
    chunks.map((chunk) => chunk.replace(SYNTAX_CHARS, '\\$&')).join(SEPARATOR));
  return new RegExp(
    String.raw`(^|[^\p{L}\p{M}\p{N}_])(${alternatives.join('|')})${END}`,
    'giu',
  );
}

// One pass over the text with every entry at once (longest entry wins at a
// position), so within a pass a replacement is never rewritten.
function replaceOnce(
  text: string,
  matcher: RegExp,
  byKey: ReadonlyMap<string, string>,
): string {
  return text.replace(
    matcher,
    (match: string, lead: string, heard: string, offset: number) => {
      const spelled = byKey.get(foldKey(heard));
      const start = offset + lead.length;
      const insideWord = APOSTROPHE.test(lead) && LETTER_OR_DIGIT.test(text[offset - 1] ?? '');
      if (spelled === undefined || insideWord || touchesCode(text, start, start + heard.length)) {
        return match;
      }
      return lead + spelled;
    },
  );
}

/**
 * Most passes that may change the text before it must have settled. Hitting
 * the cap fails closed: the input is returned unchanged, including any
 * unrelated matches that would otherwise have been fixed.
 */
const MAX_PASSES = 3;

/**
 * Returns `text` with each dictionary entry spelled as saved. Passes repeat
 * until one changes nothing, so a spelling that lines up with a neighbouring
 * entry ("Chat GPT" next to "AskChat") settles instead of changing again on
 * the next call: the result is always a fixpoint, and running this twice
 * gives the same text as running it once (the dictation path runs it after
 * the engine and again after cleanup). If the text has not settled after
 * `MAX_PASSES` changing passes it is returned as it came in. Text with
 * nothing to change is returned as it came in.
 */
export function replaceDictionaryTerms(
  text: string,
  words: readonly string[],
): string {
  const entries = usableEntries(words);
  if (entries.length === 0 || !text) return text;
  const byKey = new Map(entries.map((entry) => [entry.key, entry.text]));
  const matcher = matcherFor(entries);
  const normalized = text.normalize('NFC');
  let current = normalized;
  for (let pass = 0; pass <= MAX_PASSES; pass += 1) {
    const next = replaceOnce(current, matcher, byKey);
    if (next === current) return current === normalized ? text : current;
    current = next;
  }
  return text;
}
