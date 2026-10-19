import { tokenize, type Token } from './tokens';

// Conservative lexical checks, not a semantic-equivalence guarantee.
// Require all normalized content, in order, at every length. Discount only
// removed (never swapped or inserted) fillers and articles, see tokens.ts,
// and narrowly marked source corrections.
export const CLEANUP_MIN_CONTENT_RETENTION = 1;
export const CLEANUP_MIN_CANDIDATE_COVERAGE = 1;

const NEGATION = new Set([
  'not', 'no', 'never', 'without', 'ne', 'pas', 'jamais', 'ni', 'non',
]);
const PRONOUNS = new Set([
  'i', 'we', 'you', 'he', 'she', 'they', 'it', 'me', 'us', 'him', 'her',
  'them', 'my', 'our', 'your', 'his', 'their', 'mine', 'ours', 'yours',
  'theirs', 'je', 'tu', 'nous', 'vous', 'il', 'elle', 'ils', 'elles',
]);

function words(text: string): string[] {
  return tokenize(text).map(({ word }) => word);
}

export function sameMultiset(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function oneEditApart(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  let edits = 0;
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (left.length >= right.length) i++;
    if (right.length >= left.length) j++;
  }
  return edits + Number(i < left.length || j < right.length) <= 1;
}

/** A final letter added or removed: notion ↔ notions is an inflection. */
function differsByFinalLetter(left: string, right: string): boolean {
  const [short, long] = left.length < right.length ? [left, right] : [right, left];
  return long.length === short.length + 1 && long.startsWith(short);
}

export interface SourceWord extends Token {
  /** The exact dictionary spelling when `word` is a repair or a join. */
  canonical?: string;
  /** The spoken word when `word` is its dictionary repair. */
  spoken?: string;
}

/** Lowercased dictionary key → its first exact spelling, as the prompt sends it. */
function dictionarySpellings(dictionary: readonly string[]): Map<string, string> {
  const spellings = new Map<string, string>();
  for (const term of dictionary) {
    const exact = term.trim().normalize('NFC');
    const key = exact.toLowerCase();
    if (/^[\p{L}\p{M}]{5,}$/u.test(key) && !spellings.has(key)) spellings.set(key, exact);
  }
  return spellings;
}

/**
 * Lowercased tokens with dictionary joins (vox loom → voxloom). With `repair`
 * (source text only), a word of 5+ letters one edit from exactly one
 * dictionary spelling is that spelling: this is the dictionary repair feature
 * (motion → Notion), so the output may keep the spoken word or use the exact
 * spelling. A final letter is an inflection, not a typo, so notions is never
 * repaired to Notion. Output words are never snapped, or `motion` → `nation`
 * would pass. Skippable source words (fillers, articles outside quotations)
 * may be dropped, never swapped.
 */
export function contentWords(
  text: string,
  dictionary: readonly string[],
  repair = false,
): SourceWord[] {
  const tokens = tokenize(text);
  const spellings = dictionarySpellings(dictionary);
  const canonical: SourceWord[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const { end, skippable, start, word } = tokens[i];
    const joined = word + (tokens[i + 1]?.word ?? '');
    if (i + 1 < tokens.length && spellings.has(joined)) {
      canonical.push({
        canonical: spellings.get(joined), end: tokens[i + 1].end,
        skippable: false, start, word: joined,
      });
      i++;
      continue;
    }
    const matches = repair && word.length >= 5
      ? [...spellings.keys()].filter((term) => oneEditApart(word, term)
        && !differsByFinalLetter(word, term))
      : [];
    canonical.push(matches.length === 1 && matches[0] !== word
      ? {
          canonical: spellings.get(matches[0]), end, skippable: false,
          spoken: word, start, word: matches[0],
        }
      : { end, skippable, start, word });
  }
  return canonical;
}

/**
 * For each UTF-16 offset into the NFC `text` (ascending), how many words that
 * must survive (not skippable) end at or before it. Anchors quotes and marks,
 * so a dropped filler or article before a mark does not move it.
 */
export function anchorCounts(
  text: string,
  offsets: readonly number[],
  dictionary: readonly string[],
): number[] {
  const ends = contentWords(text, dictionary)
    .filter(({ skippable }) => !skippable).map(({ end }) => end);
  let count = 0;
  return offsets.map((offset) => {
    while (count < ends.length && ends[count] <= offset) count++;
    return count;
  });
}

export function preservesContent(
  raw: string,
  candidate: string,
  dictionary: readonly string[],
): boolean {
  const rawWords = words(raw);
  const candidateWords = words(candidate);
  for (const guarded of [NEGATION, PRONOUNS]) {
    if (!sameMultiset(
      rawWords.filter((word) => guarded.has(word)),
      candidateWords.filter((word) => guarded.has(word)),
    )) return false;
  }
  // Only an explicit, single-word source correction may remove content.
  // Never discount invented corrections in the candidate. Technical values
  // and negation remain independently protected, even across corrections.
  const correctedRaw = raw.replace(
    /\b([\p{L}]+),\s*(?:sorry|correction),\s*([\p{L}]+)\b/giu,
    '$2',
  );
  // Every candidate word, fillers included, must map onto the source.
  const normalized = candidate.normalize('NFC');
  const output = contentWords(candidate, dictionary).map(({ end, start, word }) => ({
    surface: normalized.slice(start, end), word,
  }));
  if (!output.length) return sameMultiset(rawWords, candidateWords);
  return coveredInOrder(contentWords(raw, dictionary, true), output)
    || (correctedRaw !== raw
      && coveredInOrder(contentWords(correctedRaw, dictionary, true), output));
}

interface OutputWord {
  /** The candidate's own text for this word, case kept. */
  surface: string;
  word: string;
}

/**
 * A repaired or joined word written as one word must use the exact
 * dictionary spelling (Voxloom, not voxloom). Keeping the spoken form
 * (Voxlom, vox loom) is always allowed.
 */
function spelledAsDictionary(source: SourceWord, output: OutputWord): boolean {
  if (!source.canonical || output.word !== source.word) return true;
  return /\s/u.test(output.surface) || output.surface === source.canonical;
}

// The output must be the source in order, minus only skippable source words:
// a filler or article may be removed, but a swapped or inserted one is unmatched.
function coveredInOrder(source: SourceWord[], output: OutputWord[]): boolean {
  const required = source.filter(({ skippable }) => !skippable).length;
  if (!required) return false;
  let matched = 0;
  let kept = 0;
  for (const sourceWord of source) {
    const { skippable, spoken, word } = sourceWord;
    const next = output[matched];
    if (next !== undefined && (word === next.word || spoken === next.word)) {
      if (!spelledAsDictionary(sourceWord, next)) return false;
      matched++;
      if (!skippable) kept++;
    } else if (!skippable) {
      return false;
    }
  }
  return kept / required >= CLEANUP_MIN_CONTENT_RETENTION
    && matched / output.length >= CLEANUP_MIN_CANDIDATE_COVERAGE;
}
