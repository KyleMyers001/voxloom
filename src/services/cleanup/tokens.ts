// Word tokens for the cleanup guards, with the context that decides whether
// a source word may be dropped: lowercase fillers and articles, or title-case
// ones that open a sentence (Whisper capitalizes "Um"), but never inside a
// quotation, where the source is kept verbatim.

export const FILLERS = new Set(['um', 'uh', 'erm', 'er', 'hmm']);
export const ARTICLES = new Set(['a', 'an', 'the']);

export interface Token {
  /** Lowercased word. */
  word: string;
  /** The candidate may omit this source word. */
  skippable: boolean;
  /** UTF-16 offsets of the source word in the NFC text (end exclusive). */
  start: number;
  end: number;
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

export interface QuoteScan {
  /** Indices of quotation marks. */
  quotes: number[];
  /** Indices of apostrophes outside words: boys', '90s. */
  apostrophes: number[];
}

/**
 * Find quotation marks in `characters`. Apostrophes are not quotation
 * boundaries inside words (don't → do not, I'm → I am keep working), in a
 * decade ('90s), or after a word-final s (boys') unless a single quotation is
 * open, so a closing quote after an s (say 'yes' to it) is still anchored.
 */
export function scanQuotes(characters: readonly string[]): QuoteScan {
  const scan: QuoteScan = { apostrophes: [], quotes: [] };
  const word = /[\p{L}\p{M}\p{N}]/u;
  let singleOpen = false;
  characters.forEach((character, index) => {
    if (!/["'“”‘’]/u.test(character)) return;
    const before = characters[index - 1] ?? '';
    const after = characters[index + 1] ?? '';
    const single = /['‘’]/u.test(character);
    if (single && word.test(before) && word.test(after)) return;
    const straight = /['’]/u.test(character);
    const possessive = /^s$/iu.test(before) && !word.test(after);
    const decade = /^\p{N}{2}s(?![\p{L}\p{M}\p{N}])/u
      .test(characters.slice(index + 1, index + 5).join(''));
    if (straight && ((possessive && !singleOpen) || decade)) {
      scan.apostrophes.push(index);
      return;
    }
    if (single) singleOpen = !singleOpen;
    scan.quotes.push(index);
  });
  return scan;
}

export function quoteMarkIndices(characters: readonly string[]): number[] {
  return scanQuotes(characters).quotes;
}

/** The UTF-16 string offset of each code point in `characters`. */
export function utf16Offsets(characters: readonly string[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const character of characters) {
    offsets.push(offset);
    offset += character.length;
  }
  return offsets;
}

/** `text[start]` begins the text or a sentence (after . ! ?). */
function opensSentence(text: string, start: number): boolean {
  let at = start - 1;
  while (at >= 0 && /[\s"'“”‘’([]/u.test(text[at])) at--;
  return at < 0 || /[.!?。！？]/u.test(text[at]);
}

/**
 * A filler or article the speaker can lose: lowercase, or title case opening
 * a sentence (Whisper writes "Um", "The"); never "UM", "ER", "THE" or a
 * mid-sentence "A", which are content.
 */
function isDroppable(words: Set<string>, word: string, sentenceStart: boolean): boolean {
  const lower = word.toLowerCase();
  if (!words.has(lower)) return false;
  return word === lower || (sentenceStart && /^\p{Lu}\p{Ll}*$/u.test(word));
}

export function isDroppableFiller(word: string, sentenceStart: boolean): boolean {
  return isDroppable(FILLERS, word, sentenceStart);
}

/**
 * One pass over the NFC text. Contractions expand per word (don't → do not),
 * so every token keeps its source offset for anchoring quotes and marks.
 */
export function tokenize(text: string): Token[] {
  const normalized = text.normalize('NFC');
  // scanQuotes works on code points; map its indices to string offsets.
  const characters = Array.from(normalized);
  const offsets = utf16Offsets(characters);
  const quotes = scanQuotes(characters).quotes.map((index) => offsets[index]);
  const tokens: Token[] = [];
  let quotesBefore = 0;
  for (const match of normalized.matchAll(/[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}]+)*/gu)) {
    const start = match.index;
    while (quotesBefore < quotes.length && quotes[quotesBefore] < start) quotesBefore++;
    const quoted = quotesBefore % 2 === 1;
    const end = start + match[0].length;
    expand(match[0]).split(' ').filter(Boolean).forEach((word, part) => {
      const sentenceStart = part === 0 && opensSentence(normalized, start);
      const skippable = !quoted && (isDroppable(ARTICLES, word, sentenceStart)
        || isDroppable(FILLERS, word, sentenceStart));
      tokens.push({ end, skippable, start, word: word.toLowerCase() });
    });
  }
  return tokens;
}
