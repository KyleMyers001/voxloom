export type WordResult =
  | { error: string; ok: false }
  | { ok: true; word: string };

/**
 * Tabs, line breaks and other control characters: below space, DEL, the C1
 * controls (U+0080 to U+009F) and the Unicode line and paragraph separators
 * (U+2028, U+2029). Wider than the cleanup output check, which allows tab and
 * line breaks in prose. Trimming already removes a leading or trailing tab,
 * line break or separator, so this mostly catches one in the middle.
 */
export function hasControlCharacter(word: string): boolean {
  for (const character of word) {
    const point = character.codePointAt(0)!;
    if (point < 32 || (point >= 127 && point <= 159) || point === 0x2028 || point === 0x2029) {
      return true;
    }
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
