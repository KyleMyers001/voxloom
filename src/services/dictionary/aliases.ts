/// "Also heard as" (BUS-138): per-word aliases, what the engine tends to hear
/// instead of the word ("box loom" for Voxloom). Stored as an optional
/// `aliases` object next to `words` in dictionary.json, keyed by the word.
/// One set of rules decides what an alias may be, for the dialog and for
/// loading a file, so the app never saves what it would drop on the next load.

import { hasControlCharacter } from '../../domain/dictionary';
import { entryChunks } from './chunks';
import { foldKey, isPlainCommonWord, readsBackAsItself, shapeOf } from './entries';

/** Aliases by word, written exactly as saved in `words`. */
export type DictionaryAliases = Record<string, string[]>;

export const MAX_ALIASES_PER_WORD = 8;
/** Same per-entry bound the cleanup prompt applies to a dictionary word. */
export const ALIAS_MAX_BYTES = 128;

export type AliasesResult = { error: string; ok: false } | { aliases: string[]; ok: true };

/** Who already holds a spelling: a word, or an alias of `word`. */
interface Holder {
  alias: boolean;
  word: string;
}
type Issue = { kind: 'control' | 'long' | 'shape' | 'common' } | { holder: Holder; kind: 'taken' };

const encoder = new TextEncoder();

/** The comma-separated field as a list: trimmed, blanks dropped. */
export function splitAliasInput(input: string): string[] {
  return input.split(',').map((part) => part.trim()).filter(Boolean);
}

/**
 * Spellings in use, by letters (`k:`) and by letters plus spacing (`s:`). An
 * alias may share its own word's letters when the spacing differs ("vox loom"
 * for Voxloom); it may never share anything with another entry.
 */
type Taken = Map<string, Holder>;

function claim(taken: Taken, spelled: string, holder: Holder) {
  const chunks = entryChunks(spelled);
  const letters = `k:${foldKey(chunks.join(''))}`;
  if (!taken.has(letters)) taken.set(letters, holder);
  taken.set(`s:${shapeOf(chunks)}`, holder);
}

function issueWith(alias: string, taken: Taken, own: string): Issue | null {
  if (hasControlCharacter(alias)) return { kind: 'control' };
  if (encoder.encode(alias).byteLength > ALIAS_MAX_BYTES) return { kind: 'long' };
  const chunks = entryChunks(alias);
  if (chunks.length === 0 || alias.includes(',') || !readsBackAsItself(alias.normalize('NFC'))) {
    return { kind: 'shape' };
  }
  if (isPlainCommonWord(chunks)) return { kind: 'common' };
  const sameShape = taken.get(`s:${shapeOf(chunks)}`);
  if (sameShape) return { holder: sameShape, kind: 'taken' };
  const sameLetters = taken.get(`k:${foldKey(chunks.join(''))}`);
  return sameLetters && sameLetters.word !== own ? { holder: sameLetters, kind: 'taken' } : null;
}

function takenSpellings(
  words: readonly string[],
  aliases: DictionaryAliases,
  skip?: string,
): Taken {
  const taken: Taken = new Map();
  for (const word of words) {
    if (word !== skip) claim(taken, word, { alias: false, word });
  }
  for (const [word, list] of Object.entries(aliases)) {
    if (word === skip || !words.includes(word)) continue;
    for (const alias of list) claim(taken, alias, { alias: true, word });
  }
  return taken;
}

function message(alias: string, issue: Issue, own: string): string {
  if (issue.kind === 'taken') {
    const { alias: isAlias, word } = issue.holder;
    if (word === own) return isAlias ? `"${alias}" is listed twice.` : `"${alias}" is the word itself.`;
    return isAlias
      ? `"${alias}" is already an alias of ${word}.`
      : `"${alias}" is already in your dictionary.`;
  }
  if (issue.kind === 'control') {
    return 'An alias can\'t contain tabs, line breaks or other control characters.';
  }
  if (issue.kind === 'long') return `"${alias}" is too long for an alias.`;
  if (issue.kind === 'common') {
    return `"${alias}" is a common word and would change ordinary speech. Use a longer phrase.`;
  }
  return `"${alias}" has a hyphen or spacing that can't be matched. Use single hyphens or spaces between words.`;
}

/**
 * Check the "Also heard as" field for `word` (being added, or `editing` being
 * saved). An alias must not equal, ignoring case, spaces and hyphens, the word
 * itself, another word, another word's alias or an earlier alias in the field.
 * The first problem in field order is reported.
 */
export function validateAliases(
  input: string,
  word: string,
  words: readonly string[],
  aliases: DictionaryAliases,
  editing?: string,
): AliasesResult {
  const list = splitAliasInput(input);
  if (list.length > MAX_ALIASES_PER_WORD) {
    return { error: `A word can have up to ${MAX_ALIASES_PER_WORD} aliases.`, ok: false };
  }
  const taken = takenSpellings(words, aliases, editing);
  claim(taken, word, { alias: false, word });
  for (const alias of list) {
    const issue = issueWith(alias, taken, word);
    if (issue) return { error: message(alias, issue, word), ok: false };
    claim(taken, alias, { alias: true, word });
  }
  return { aliases: list, ok: true };
}

/** A word may not be the spelling of another word's alias (the word would win and the alias vanish). */
export function validateWordAgainstAliases(
  word: string,
  aliases: DictionaryAliases,
  editing?: string,
): { error: string; ok: false } | { ok: true } {
  const key = foldKey(word);
  for (const [owner, list] of Object.entries(aliases)) {
    if (owner !== editing && list.some((alias) => foldKey(alias) === key)) {
      return { error: `"${word}" is already an alias of ${owner}.`, ok: false };
    }
  }
  return { ok: true };
}

/**
 * Aliases as read from a file, for the normalised `words`: keys matched to a
 * word ignoring case (first key wins) and re-keyed to the word as saved; an
 * alias that fails the rules above is dropped, never the whole file. Words
 * are taken in order and a spelling is kept once, so words beat aliases and
 * the earlier word's alias beats a later one. At most 8 per word; the file
 * order is kept. A value that is not an object gives none.
 */
export function normalizeAliases(raw: unknown, words: readonly string[]): DictionaryAliases {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const byKey = new Map<string, unknown>();
  for (const [key, value] of Object.entries(raw)) {
    const lower = key.trim().toLowerCase();
    if (!byKey.has(lower)) byKey.set(lower, value);
  }
  const taken: Taken = new Map();
  for (const word of words) claim(taken, word, { alias: false, word });
  const result = new Map<string, string[]>();
  for (const word of words) {
    const list = byKey.get(word.toLowerCase());
    if (!Array.isArray(list)) continue;
    const kept: string[] = [];
    for (const entry of list) {
      if (typeof entry !== 'string' || kept.length === MAX_ALIASES_PER_WORD) continue;
      const alias = entry.trim();
      if (!alias || issueWith(alias, taken, word)) continue;
      claim(taken, alias, { alias: true, word });
      kept.push(alias);
    }
    if (kept.length > 0) result.set(word, kept);
  }
  // fromEntries defines each key as data, so a word named "__proto__" is safe.
  return Object.fromEntries(result);
}
