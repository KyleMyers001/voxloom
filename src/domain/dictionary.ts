export type WordResult =
  | { error: string; ok: false }
  | { ok: true; word: string };

/**
 * Tabs, line breaks and other control characters (the same set cleanup output
 * rejects: below space, DEL). A trimmed word never starts or ends with one, so
 * this is about a character in the middle.
 */
export function hasControlCharacter(word: string): boolean {
  for (const character of word) {
    const point = character.codePointAt(0)!;
    if (point < 32 || point === 127) return true;
  }
  return false;
}

export function validateWord(
  value: string,
  words: string[],
  editing?: string,
): WordResult {
  const word = value.trim();
  if (!word) return { error: 'Enter a word.', ok: false };
  if (hasControlCharacter(word)) {
    return {
      error: 'A word can\'t contain tabs, line breaks or other control characters.',
      ok: false,
    };
  }
  const duplicate = words.some((candidate) =>
    candidate !== editing && candidate.toLowerCase() === word.toLowerCase()
  );
  if (duplicate) {
    return { error: `${word} is already in your dictionary.`, ok: false };
  }
  return { ok: true, word };
}
