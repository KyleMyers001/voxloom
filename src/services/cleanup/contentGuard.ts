import { dictionarySpellings, findSpan } from './dictionarySpans';
import { NEGATION, PRONOUNS } from './guardedWords';
import { tokenize, type Token } from './tokens';

// Conservative lexical checks, not a semantic-equivalence guarantee.
// Require all normalized content, in order, at every length. Discount only
// removed (never swapped or inserted) fillers and articles, see tokens.ts,
// and narrowly marked source corrections.
export const CLEANUP_MIN_CONTENT_RETENTION = 1;
export const CLEANUP_MIN_CANDIDATE_COVERAGE = 1;

function words(text: string): string[] {
  return tokenize(text).map(({ word }) => word);
}

export function sameMultiset(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export interface SourceWord extends Token {
  /** The exact dictionary spelling when `word` is a repair or a join. */
  canonical?: string;
  /** The spoken words when `word` is their dictionary repair. */
  spoken?: string[];
  /** Where each spoken word sits, for a repair of several words (box-loom). */
  parts?: { end: number; start: number }[];
}

/**
 * Lowercased tokens with dictionary joins (vox loom → voxloom). With `repair`
 * (source text only), 1 to 3 adjacent words close to one dictionary spelling
 * are that spelling (motion → Notion, box loom → Voxloom), see
 * dictionarySpans.ts: this is the dictionary repair feature, so the output may
 * keep the spoken words or use the exact spelling. Output words are never
 * snapped, or `motion` → `nation` would pass. Skippable source words
 * (fillers, articles outside quotations) may be dropped, never swapped.
 */
export function contentWords(
  text: string,
  dictionary: readonly string[],
  repair = false,
): SourceWord[] {
  const normalized = text.normalize('NFC');
  const tokens = tokenize(normalized);
  const spellings = dictionarySpellings(dictionary);
  const canonical: SourceWord[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const { continuesWord, end, skippable, start, word } = tokens[i];
    const span = spellings.size
      ? findSpan(normalized, tokens, i, spellings, repair) : null;
    if (!span) {
      canonical.push({ continuesWord, end, skippable, start, word });
      continue;
    }
    const last = tokens[i + span.length - 1];
    canonical.push({
      canonical: span.canonical,
      continuesWord: span.length === 1 && continuesWord,
      end: last.end, parts: span.spoken && span.length > 1
        ? tokens.slice(i, i + span.length).map((part) => ({ end: part.end, start: part.start }))
        : undefined,
      skippable: false, spoken: span.spoken, start, word: span.word,
    });
    i += span.length - 1;
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
 * A repaired or joined word written as the dictionary word must use its
 * exact spelling (Voxloom, not voxloom). Keeping the spoken form (Voxlom,
 * vox loom, can't for [cannot]) is always allowed. A repaired span is never
 * half fixed: a joined output like "Vox loom" for box loom is neither the
 * spoken words nor the spelling.
 */
function spelledAsDictionary(source: SourceWord, output: OutputWord): boolean {
  if (!source.canonical || output.word !== source.word) return true;
  if (source.spoken) return output.surface === source.canonical;
  return output.surface.toLowerCase() !== source.word
    || output.surface === source.canonical;
}

/** How many output words from `at` stand for `source`: its word or its spoken words. */
function matchedWords(source: SourceWord, output: OutputWord[], at: number): number {
  if (output[at] === undefined) return 0;
  if (output[at].word === source.word) return spelledAsDictionary(source, output[at]) ? 1 : -1;
  const { spoken } = source;
  return spoken?.every((word, index) => output[at + index]?.word === word)
    ? spoken.length : 0;
}

// The output must be the source in order, minus only skippable source words:
// a filler or article may be removed, but a swapped or inserted one is unmatched.
function coveredInOrder(source: SourceWord[], output: OutputWord[]): boolean {
  const required = source.filter(({ skippable }) => !skippable).length;
  if (!required) return false;
  let matched = 0;
  let kept = 0;
  for (const sourceWord of source) {
    const count = matchedWords(sourceWord, output, matched);
    if (count < 0) return false;
    if (count > 0) {
      matched += count;
      if (!sourceWord.skippable) kept++;
    } else if (!sourceWord.skippable) {
      return false;
    }
  }
  return kept / required >= CLEANUP_MIN_CONTENT_RETENTION
    && matched / output.length >= CLEANUP_MIN_CANDIDATE_COVERAGE;
}
