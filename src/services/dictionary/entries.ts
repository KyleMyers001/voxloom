/// Matcher entries (BUS-138): one per dictionary word and one per alias. An
/// alias ("also heard as") is another spelling that is replaced by its word's
/// saved text, and goes through the same matcher.

import type { DictionaryAliases } from './aliases';
import { entryChunks } from './chunks';
import { isCommonWord } from './commonWords';

export interface Entry {
  chunks: string[];
  key: string;
  /** What the matcher writes: the saved word (never the alias). */
  text: string;
}

const SEPARATORS = /[\s-]+/gu;

// Final sigma: "ΠΑΎΛΟΥΣ" lowercases to ς at the end of a word but σ inside one,
// so both sides of a lookup are folded to σ.
export const foldKey = (spelled: string) =>
  spelled.replace(SEPARATORS, '').toLowerCase().replace(/ς/gu, 'σ');

/** The spelling pattern: chunks folded, so case, spaces and hyphens do not matter. */
export const shapeOf = (chunks: readonly string[]) => chunks.map(foldKey).join(' ');

/**
 * Entry text the matcher reads back as itself: whitespace runs only of spaces
 * or tabs, a single hyphen between chunks, and no hyphen at either end. Other
 * entries ("--verbose", "chat - gpt") would not match their own output, so a
 * second pass would grow or rewrite them. They are left out.
 */
export function readsBackAsItself(text: string): boolean {
  if (text.startsWith('-') || text.endsWith('-')) return false;
  return (text.match(SEPARATORS) ?? []).every((run) => /^(?:[^\S\r\n]+|-)$/u.test(run));
}

/**
 * A plain common word on its own ("Will", "Sky", "IT") can only be a case
 * change, and forcing it would recapitalise every ordinary use. Phrases,
 * hyphenated words and entries with digits or internal capitals are kept.
 */
export function isPlainCommonWord(chunks: readonly string[]): boolean {
  return chunks.length === 1 && /^\p{L}+$/u.test(chunks[0]) && isCommonWord(chunks[0]);
}

/**
 * Usable entries, longest first. Words come first, then aliases; a repeated
 * spelling keeps its first entry, so a word beats an alias and the first word
 * in the list beats a later word's alias. Two spellings with the same letters
 * but a different spacing ("Voxloom" and the alias "vox loom") may both stay
 * when they write the same text, since the matcher looks the text up by those
 * letters.
 */
export function usableEntries(
  words: readonly string[],
  aliases: DictionaryAliases = {},
): Entry[] {
  const shapes = new Set<string>();
  const written = new Map<string, string>();
  const entries: Entry[] = [];
  const add = (spelled: string, text: string) => {
    const chunks = entryChunks(spelled);
    if (chunks.length === 0) return;
    const key = foldKey(chunks.join(''));
    const shape = shapeOf(chunks);
    if (!readsBackAsItself(spelled.trim().normalize('NFC')) || shapes.has(shape)) return;
    if (written.has(key) && written.get(key) !== text) return;
    shapes.add(shape);
    written.set(key, text);
    if (!isPlainCommonWord(chunks)) entries.push({ chunks, key, text });
  };
  for (const word of words) add(word, word.trim().normalize('NFC'));
  for (const word of words) {
    const list = Object.hasOwn(aliases, word) ? aliases[word] : undefined;
    if (!Array.isArray(list)) continue;
    for (const alias of list) {
      if (typeof alias === 'string') add(alias, word.trim().normalize('NFC'));
    }
  }
  return entries.sort((a, b) => b.key.length - a.key.length);
}
