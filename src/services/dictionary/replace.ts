/// Deterministic dictionary spelling (BUS-138): once the transcript exists,
/// every dictionary entry is written exactly as saved wherever it was heard
/// differing only in case or in spacing/hyphens ("chat gpt" -> "ChatGPT").
/// No model, no sound-alike guessing. The only different-letter rewrites are
/// the aliases the user states ("box loom" -> "Voxloom"); nothing else is
/// rewritten that an entry does not spell out.

import type { DictionaryAliases } from './aliases';
import { touchesCode } from './codeContext';
import { type Entry, foldKey, usableEntries } from './entries';

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
const SYNTAX_CHARS = /[\\^$.*+?()[\]{}|/]/gu;

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
 * Returns `text` with each dictionary entry spelled as saved, and each alias
 * (what the engine tends to hear instead, stated per word) replaced by its
 * word. An alias may differ in letters; everything else (boundaries, code-like
 * text, apostrophes, longest first) is the same for words and aliases. Passes repeat
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
  aliases?: DictionaryAliases,
): string {
  const entries = usableEntries(words, aliases);
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
