/// Where a dictionary match may start and end in running text (BUS-138).

export const WORD_CHAR = String.raw`[\p{L}\p{M}\p{N}_]`;
// A match can't start right after an apostrophe inside a word (a letter or
// digit before it: "we're", "it\u2019s", "l'iphone"); it may end before one,
// so possessives work ("Voxloom's"), except before another contraction tail
// ("don't" is not a match for "Don"). Lookbehind is avoided on purpose: the
// start edge is a captured character that is put back and checked by callers.
const APOSTROPHE = /^['\u2019]$/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
export const END = String.raw`(?!${WORD_CHAR})(?!['\u2019](?!s(?!${WORD_CHAR}))\p{L})`;
const ENDS_CLEANLY = new RegExp(`^${END}`, 'u');

/** `lead` is the character before a match and `before` the one before that. */
export function startsInsideWord(lead: string, before: string): boolean {
  return APOSTROPHE.test(lead) && LETTER_OR_DIGIT.test(before);
}

/** The text after a match, `rest`, does not continue the word. */
export function endsCleanly(rest: string): boolean {
  return ENDS_CLEANLY.test(rest);
}
