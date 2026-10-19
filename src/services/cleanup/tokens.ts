// Word tokens for the cleanup guards, with the context that decides whether
// a source word may be dropped: lowercase fillers, title-case fillers that
// open a sentence (Whisper capitalizes "Um"), and articles, but never
// inside a quotation, where the source is kept verbatim.

export const FILLERS = new Set(['um', 'uh', 'erm', 'er', 'hmm']);
export const ARTICLES = new Set(['a', 'an', 'the']);

export interface Token {
  /** Lowercased word. */
  word: string;
  /** The candidate may omit this source word. */
  skippable: boolean;
}

/** Expand supported contractions, keeping case and quote characters. */
function expand(text: string): string {
  return text.normalize('NFC')
    .replaceAll('’', '\'')
    .replace(/\bcan't\b/giu, 'can not')
    .replace(/\bwon't\b/giu, 'will not')
    .replace(/n't\b/giu, ' not')
    .replace(/\bcannot\b/giu, 'can not')
    .replace(/\bi'm\b/giu, 'i am')
    .replace(/'re\b/giu, ' are')
    .replace(/'ve\b/giu, ' have')
    .replace(/'ll\b/giu, ' will')
    .replace(/\bn'/giu, 'ne ');
}

/**
 * Indices of quotation marks in `characters`. Apostrophes inside words are
 * not quotation boundaries (don't → do not, I'm → I am keep working).
 */
export function quoteMarkIndices(characters: readonly string[]): number[] {
  const indices: number[] = [];
  characters.forEach((character, index) => {
    if (!/["'“”‘’]/u.test(character)) return;
    if (/['‘’]/u.test(character)
      && /[\p{L}\p{M}\p{N}]/u.test(characters[index - 1] ?? '')
      && /[\p{L}\p{M}\p{N}]/u.test(characters[index + 1] ?? '')) return;
    indices.push(index);
  });
  return indices;
}

/** First word of the text or of a sentence (after . ! ?). */
function opensSentence(before: string): boolean {
  const trimmed = before.replace(/[\s"'“”‘’([]+$/u, '');
  return trimmed === '' || /[.!?。！？]$/u.test(trimmed);
}

/** A filler the speaker can lose: "um", or "Um" opening a sentence; never "UM"/"ER". */
export function isDroppableFiller(word: string, sentenceStart: boolean): boolean {
  const lower = word.toLowerCase();
  if (!FILLERS.has(lower)) return false;
  return word === lower || (sentenceStart && /^\p{Lu}\p{Ll}+$/u.test(word));
}

export function tokenize(text: string): Token[] {
  const expanded = expand(text);
  const marks = quoteMarkIndices(Array.from(expanded));
  // quoteMarkIndices works on code points; map them to string offsets.
  const offsets: number[] = [];
  let offset = 0;
  for (const character of expanded) {
    offsets.push(offset);
    offset += character.length;
  }
  const markOffsets = marks.map((index) => offsets[index]);
  const tokens: Token[] = [];
  for (const match of expanded.matchAll(/[\p{L}\p{M}\p{N}]+(?:'[\p{L}\p{M}]+)*/gu)) {
    const start = match.index;
    const word = match[0];
    const quoted = markOffsets.filter((mark) => mark < start).length % 2 === 1;
    const lower = word.toLowerCase();
    const skippable = !quoted && (ARTICLES.has(lower)
      || isDroppableFiller(word, opensSentence(expanded.slice(0, start))));
    tokens.push({ skippable, word: lower });
  }
  return tokens;
}
