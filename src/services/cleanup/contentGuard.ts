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

/**
 * Lowercased, dictionary-canonicalized tokens. Skippable source words
 * (fillers, articles outside quotations) may be dropped, never swapped.
 */
function contentWords(text: string, dictionary: readonly string[]): Token[] {
  const tokens = tokenize(text);
  const spellings = dictionary.map((term) => term.normalize('NFC').toLowerCase())
    .filter((term) => /^[\p{L}\p{M}]{5,}$/u.test(term));
  const canonical: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const { skippable, word } = tokens[i];
    const joined = word + (tokens[i + 1]?.word ?? '');
    if (i + 1 < tokens.length && spellings.includes(joined)) {
      canonical.push({ skippable: false, word: joined });
      i++;
      continue;
    }
    const matches = word.length >= 5
      ? spellings.filter((term) => oneEditApart(word, term)) : [];
    canonical.push(matches.length === 1
      ? { skippable: false, word: matches[0] } : { skippable, word });
  }
  return canonical;
}

/** Words that must survive (not skippable) in `text`; anchors quote marks. */
export function anchorWordCount(text: string, dictionary: readonly string[]): number {
  return contentWords(text, dictionary).filter(({ skippable }) => !skippable).length;
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
  const output = contentWords(candidate, dictionary).map(({ word }) => word);
  if (!output.length) return sameMultiset(rawWords, candidateWords);
  return coveredInOrder(contentWords(raw, dictionary), output)
    || (correctedRaw !== raw
      && coveredInOrder(contentWords(correctedRaw, dictionary), output));
}

// The output must be the source in order, minus only skippable source words:
// a filler or article may be removed, but a swapped or inserted one is unmatched.
function coveredInOrder(source: Token[], output: string[]): boolean {
  const required = source.filter(({ skippable }) => !skippable).length;
  if (!required) return false;
  let matched = 0;
  let kept = 0;
  for (const { skippable, word } of source) {
    if (word === output[matched]) {
      matched++;
      if (!skippable) kept++;
    } else if (!skippable) {
      return false;
    }
  }
  return kept / required >= CLEANUP_MIN_CONTENT_RETENTION
    && matched / output.length >= CLEANUP_MIN_CANDIDATE_COVERAGE;
}
