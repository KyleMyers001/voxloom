/// Words whose loss or gain flips meaning. The cleanup output check keeps them
/// as a multiset (preservesContent), and the dictionary's exact-letter join
/// never reads them as part of a longer word ("not ion" is not Notion).

export const NEGATION = new Set([
  'not', 'no', 'never', 'without', 'nor', 'neither', 'nothing', 'none',
  'cannot', 'ne', 'pas', 'jamais', 'ni', 'non',
]);
export const PRONOUNS = new Set([
  'i', 'we', 'you', 'he', 'she', 'they', 'it', 'me', 'us', 'him', 'her',
  'them', 'my', 'our', 'your', 'his', 'their', 'mine', 'ours', 'yours',
  'theirs', 'je', 'tu', 'nous', 'vous', 'il', 'elle', 'ils', 'elles',
]);

export function isGuardedWord(word: string): boolean {
  const lower = word.toLowerCase();
  return NEGATION.has(lower) || PRONOUNS.has(lower);
}
