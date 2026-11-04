import { hasControlCharacter } from '../../domain/dictionary';
import { type DictionaryAliases, normalizeAliases } from './aliases';

/** On-disk schema version for `dictionary.json`. */
export const DICTIONARY_FILE_VERSION = 1 as const;

export interface DictionaryFile {
  /**
   * Optional in the file (BUS-138): what the engine tends to hear instead of
   * a word, keyed by the word. Missing means none.
   */
  aliases: DictionaryAliases;
  version: typeof DICTIONARY_FILE_VERSION;
  words: string[];
}

export type ParseDictionaryResult =
  | { ok: true; file: DictionaryFile }
  | { ok: false; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize a words array: keep non-empty trimmed strings, drop blanks and
 * entries with a control character, tab or line break inside (an old file with
 * one still loads, minus that entry), de-dupe case-insensitively (first casing
 * wins), sort locale-insensitive.
 */
export function normalizeWords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const words: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const word = entry.trim();
    if (!word || hasControlCharacter(word)) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  return words.sort((a, b) => a.localeCompare(b, undefined, {
    sensitivity: 'base',
  }));
}

/**
 * Parse and validate a dictionary JSON document.
 * Corrupt / unknown version → error (caller uses empty; must not wipe
 * settings.json or history.json). Missing file is handled by the store
 * before parse. Invalid individual entries are skipped inside a valid
 * envelope. `aliases` is optional: missing or malformed gives none, and a bad
 * alias is dropped on its own (see normalizeAliases).
 */
export function parseDictionaryJson(raw: string): ParseDictionaryResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { error: 'Dictionary file is not valid JSON', ok: false };
  }
  if (!isObject(parsed)) {
    return { error: 'Dictionary file root must be an object', ok: false };
  }
  if (parsed.version !== DICTIONARY_FILE_VERSION) {
    return {
      error: `Unsupported dictionary file version: ${String(parsed.version)}`,
      ok: false,
    };
  }
  if (!Array.isArray(parsed.words)) {
    return { error: 'Dictionary file words must be an array', ok: false };
  }
  const words = normalizeWords(parsed.words);
  return {
    file: {
      aliases: normalizeAliases(parsed.aliases, words),
      version: DICTIONARY_FILE_VERSION,
      words,
    },
    ok: true,
  };
}

/**
 * The file as written. `aliases` is written only when there are any, so a
 * dictionary without aliases is byte for byte what earlier builds wrote.
 */
export function serializeDictionaryFile(
  words: string[],
  aliases: DictionaryAliases = {},
): string {
  const normalized = normalizeWords(words);
  const kept = normalizeAliases(aliases, normalized);
  const file = {
    version: DICTIONARY_FILE_VERSION,
    words: normalized,
    ...(Object.keys(kept).length > 0 ? { aliases: kept } : {}),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function defaultDictionaryFile(): DictionaryFile {
  return {
    aliases: {},
    version: DICTIONARY_FILE_VERSION,
    words: [],
  };
}
