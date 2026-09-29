export type WordResult =
  | { error: string; ok: false }
  | { ok: true; word: string };

export function validateWord(
  value: string,
  words: string[],
  editing?: string,
): WordResult {
  const word = value.trim();
  if (!word) return { error: 'Enter a word.', ok: false };
  const duplicate = words.some((candidate) =>
    candidate !== editing && candidate.toLowerCase() === word.toLowerCase()
  );
  if (duplicate) {
    return { error: `${word} is already in your dictionary.`, ok: false };
  }
  return { ok: true, word };
}
