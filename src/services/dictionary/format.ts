/** On-disk schema version for `dictionary.json`. */
export const DICTIONARY_FILE_VERSION = 1 as const;

export interface DictionaryFile {
  version: typeof DICTIONARY_FILE_VERSION;
  words: string[];
}

export type ParseDictionaryResult =
  | { ok: true; file: DictionaryFile }
  | { ok: false; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a words array: keep non-empty trimmed strings, drop blanks,
 * de-dupe case-insensitively (first casing wins), sort locale-insensitive.
 */
export function normalizeWords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const words: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const word = entry.trim();
    if (!word) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  return words.sort((a, b) => a.localeCompare(b, undefined, {
    sensitivity: "base",
  }));
}

/**
 * Parse and validate a dictionary JSON document.
 * Corrupt / unknown version → error (caller uses empty; must not wipe
 * settings.json or history.json). Missing file is handled by the store
 * before parse. Invalid individual entries are skipped inside a valid
 * envelope.
 */
export function parseDictionaryJson(raw: string): ParseDictionaryResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { error: "Dictionary file is not valid JSON", ok: false };
  }
  if (!isObject(parsed)) {
    return { error: "Dictionary file root must be an object", ok: false };
  }
  if (parsed.version !== DICTIONARY_FILE_VERSION) {
    return {
      error: `Unsupported dictionary file version: ${String(parsed.version)}`,
      ok: false,
    };
  }
  if (!Array.isArray(parsed.words)) {
    return { error: "Dictionary file words must be an array", ok: false };
  }
  return {
    file: {
      version: DICTIONARY_FILE_VERSION,
      words: normalizeWords(parsed.words),
    },
    ok: true,
  };
}

export function serializeDictionaryFile(words: string[]): string {
  const file: DictionaryFile = {
    version: DICTIONARY_FILE_VERSION,
    words: normalizeWords(words),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function defaultDictionaryFile(): DictionaryFile {
  return {
    version: DICTIONARY_FILE_VERSION,
    words: [],
  };
}
