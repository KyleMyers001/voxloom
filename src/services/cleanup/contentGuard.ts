// Conservative lexical checks, not a semantic-equivalence guarantee.
// Require all normalized content, in order, at every length. Discount only
// lowercase fillers, removed (never swapped) articles and narrowly marked
// source corrections.
export const CLEANUP_MIN_CONTENT_RETENTION = 1;
export const CLEANUP_MIN_CANDIDATE_COVERAGE = 1;

const FILLERS = new Set(['um', 'uh', 'erm', 'er', 'hmm']);
const ARTICLES = new Set(['a', 'an', 'the']);
const NEGATION = new Set([
  'not', 'no', 'never', 'without', 'ne', 'pas', 'jamais', 'ni', 'non',
]);
const PRONOUNS = new Set([
  'i', 'we', 'you', 'he', 'she', 'they', 'it', 'me', 'us', 'him', 'her',
  'them', 'my', 'our', 'your', 'his', 'their', 'mine', 'ours', 'yours',
  'theirs', 'je', 'tu', 'nous', 'vous', 'il', 'elle', 'ils', 'elles',
]);

// Expand supported contractions without lowercasing, so callers can still
// see each source token's case (ER is not the filler "er").
function casedWords(text: string): string[] {
  const expanded = text.normalize('NFC')
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
  return expanded.match(/[\p{L}\p{M}\p{N}]+(?:'[\p{L}\p{M}]+)*/gu) ?? [];
}

function words(text: string): string[] {
  return casedWords(text).map((word) => word.toLowerCase());
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

/** True for a lowercase source filler; "ER" or "Er" stays content. */
function isFiller(token: string): boolean {
  return FILLERS.has(token) && token === token.toLowerCase();
}

/**
 * Lowercased, dictionary-canonicalized words with lowercase fillers removed.
 * Articles are kept: callers may drop them from the source, never swap them.
 */
function contentWords(text: string, dictionary: readonly string[]): string[] {
  const tokens = casedWords(text).filter((token) => !isFiller(token))
    .map((token) => token.toLowerCase());
  const spellings = dictionary.map((term) => term.normalize('NFC').toLowerCase())
    .filter((term) => /^[\p{L}\p{M}]{5,}$/u.test(term));
  const canonical: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i];
    const joined = word + (tokens[i + 1] ?? '');
    if (i + 1 < tokens.length && spellings.includes(joined)) {
      canonical.push(joined);
      i++;
      continue;
    }
    const matches = word.length >= 5
      ? spellings.filter((term) => oneEditApart(word, term)) : [];
    canonical.push(matches.length === 1 ? matches[0] : word);
  }
  return canonical;
}

/** Content words (no fillers or articles) in `text`; anchors quote marks. */
export function anchorWordCount(text: string, dictionary: readonly string[]): number {
  return contentWords(text, dictionary).filter((word) => !ARTICLES.has(word)).length;
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
  const output = contentWords(candidate, dictionary);
  if (!output.length) return sameMultiset(rawWords, candidateWords);
  return coveredInOrder(contentWords(raw, dictionary), output)
    || (correctedRaw !== raw
      && coveredInOrder(contentWords(correctedRaw, dictionary), output));
}

// The output must be the source in order, minus only source articles: an
// article may be removed, but a swapped or inserted one is unmatched.
function coveredInOrder(source: string[], output: string[]): boolean {
  const required = source.filter((word) => !ARTICLES.has(word)).length;
  if (!required) return false;
  let matched = 0;
  let kept = 0;
  for (const word of source) {
    if (word === output[matched]) {
      matched++;
      if (!ARTICLES.has(word)) kept++;
    } else if (!ARTICLES.has(word)) {
      return false;
    }
  }
  return kept / required >= CLEANUP_MIN_CONTENT_RETENTION
    && matched / output.length >= CLEANUP_MIN_CANDIDATE_COVERAGE;
}
