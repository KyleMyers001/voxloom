/// Splits a dictionary entry into the chunks the replacer lets a space or a
/// hyphen sit between (BUS-138), so "ChatGPT", "Chat GPT" and "chat-gpt"
/// all line up. A chunk never contains whitespace or a hyphen.

const SEPARATORS = /[\s-]+/u;
const LOWER = /^\p{Ll}$/u;
const UPPER = /^\p{Lu}$/u;
const LETTER = /^\p{L}$/u;
const DIGIT = /^\p{Nd}$/u;

// A split sits between a lowercase letter and an uppercase one, and between
// a letter and a digit (either way round). Written without lookbehind: the
// oldest supported macOS WebKit (13.1) lacks it.
function splitAtChanges(word: string): string[] {
  const parts: string[] = [];
  let previous = '';
  for (const char of word) {
    const change = (LOWER.test(previous) && UPPER.test(char))
      || (LETTER.test(previous) && DIGIT.test(char))
      || (DIGIT.test(previous) && LETTER.test(char));
    if (change || parts.length === 0) parts.push(char);
    else parts[parts.length - 1] += char;
    previous = char;
  }
  return parts;
}

/**
 * Chunks of one entry, NFC-normalised. Empty for a blank or separator-only
 * entry. A lone lowercase letter that starts a word ("i" in iPhone, "e" in
 * eBay) stays glued to the next chunk, so "i phone" is never read as iPhone.
 */
export function entryChunks(entry: string): string[] {
  const chunks: string[] = [];
  for (const word of entry.normalize('NFC').split(SEPARATORS)) {
    const parts = splitAtChanges(word);
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const next = parts[index + 1];
      if (next !== undefined && LOWER.test(part)) {
        parts[index + 1] = part + next;
      } else {
        chunks.push(part);
      }
    }
  }
  return chunks;
}
