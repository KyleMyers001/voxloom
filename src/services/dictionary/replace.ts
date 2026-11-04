/// Deterministic dictionary spelling (BUS-138): once the transcript exists,
/// every dictionary entry is written exactly as saved wherever it was heard
/// differing only in case or in spacing/hyphens ("chat gpt" -> "ChatGPT").
/// No model, no sound-alike guessing (that is the optional aliases, later),
/// and nothing is rewritten that the entry does not spell out.

import { entryChunks } from './chunks';
import { isCommonWord } from './commonWords';

const WORD_CHAR = String.raw`[\p{L}\p{M}\p{N}_]`;
// Between two chunks: a run of spaces or tabs, or one hyphen, or nothing.
// Never a newline, comma or other punctuation.
const SEPARATOR = String.raw`(?:[^\S\r\n]+|-)?`;
// A match ends at a word edge. A trailing 's is left alone, but a contraction
// ("don't") is not a match for "Don". Lookbehind is avoided on purpose: the
// start edge is a captured character that is put back.
const END = String.raw`(?!${WORD_CHAR})(?!['\u2019](?!s(?!${WORD_CHAR}))\p{L})`;
const SEPARATORS = /[\s-]+/gu;
const SYNTAX_CHARS = /[\\^$.*+?()[\]{}|/]/gu;

interface Entry {
  chunks: string[];
  key: string;
  text: string;
}

const keyOf = (spelled: string) => spelled.replace(SEPARATORS, '').toLowerCase();

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
    const entry = { chunks, key: chunks.join('').toLowerCase(), text: word.trim().normalize('NFC') };
    if (seen.has(entry.key)) continue;
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

/**
 * Returns `text` with each dictionary entry spelled as saved. One pass over
 * the text with every entry at once (longest entry wins at a position), so a
 * replacement is never rewritten again. Text with nothing to change is
 * returned as it came in.
 */
export function replaceDictionaryTerms(
  text: string,
  words: readonly string[],
): string {
  const entries = usableEntries(words);
  if (entries.length === 0 || !text) return text;
  const byKey = new Map(entries.map((entry) => [entry.key, entry.text]));
  const normalized = text.normalize('NFC');
  const replaced = normalized.replace(
    matcherFor(entries),
    (match: string, lead: string, heard: string) => {
      const spelled = byKey.get(keyOf(heard));
      return spelled === undefined ? match : lead + spelled;
    },
  );
  return replaced === normalized ? text : replaced;
}
