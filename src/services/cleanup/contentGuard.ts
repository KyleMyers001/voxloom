// Conservative lexical checks, not a semantic-equivalence guarantee.
// Require all normalized content, in order, at every length. Discount only
// enumerated fillers/articles and narrowly marked source corrections.
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

function words(text: string): string[] {
  const expanded = text.normalize('NFC').toLowerCase()
    .replaceAll('’', '\'')
    .replace(/\bcan't\b/gu, 'can not')
    .replace(/\bwon't\b/gu, 'will not')
    .replace(/n't\b/gu, ' not')
    .replace(/\bcannot\b/gu, 'can not')
    .replace(/\bi'm\b/gu, 'i am')
    .replace(/'re\b/gu, ' are')
    .replace(/'ve\b/gu, ' have')
    .replace(/'ll\b/gu, ' will')
    .replace(/\bn'/gu, 'ne ');
  return expanded.match(/[\p{L}\p{M}\p{N}]+(?:'[\p{L}\p{M}]+)*/gu) ?? [];
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

function contentWords(text: string, dictionary: readonly string[]): string[] {
  const tokens = words(text);
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
  return canonical.filter((word) => !FILLERS.has(word) && !ARTICLES.has(word));
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

function coveredInOrder(source: string[], output: string[]): boolean {
  if (!source.length) return false;
  let matched = 0;
  for (const word of source) {
    if (word === output[matched]) matched++;
  }
  return matched / source.length >= CLEANUP_MIN_CONTENT_RETENTION
    && matched / output.length >= CLEANUP_MIN_CANDIDATE_COVERAGE;
}
