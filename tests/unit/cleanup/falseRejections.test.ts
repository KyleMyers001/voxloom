import { describe, expect, it } from 'vitest';
import { validateCleanupOutput } from '../../../src/services/cleanup/validation';

// BUS-16 Build D Mac findings: real Qwen3-0.6B outputs the guard rejected
// although no word changed (see the PR for the reproduction).
const JARGON = 'You\'re making a lot of progress on the stupid jargon app.';
const DICTATION = 'So I\'m doing a test to say this can work or not. To commit a '
  + 'little progress on the setup and such, you\'re kind of impressive how much '
  + 'we\'ve done. So far, I\'m really liking how the application\'s coming '
  + 'together. Now I\'m trying to find filler words to do a smirk test. I don\'t '
  + 'know how many words I\'ve actually spoken right now, but we\'re trying to '
  + 'see. Okay.';

describe('dictionary spellings are not technical values', () => {
  it('accepts a camelCase dictionary join', () => {
    const ideal = 'You\'re making a lot of progress on the StupidJargon app.';
    expect(validateCleanupOutput(JARGON, ideal, ['StupidJargon'])).toBe(ideal);
  });

  it('accepts a camelCase dictionary case repair', () => {
    expect(validateCleanupOutput(
      'Whisperkit transcribes faster than the old pipeline.',
      'WhisperKit transcribes faster than the old pipeline.',
      ['WhisperKit'],
    )).toBe('WhisperKit transcribes faster than the old pipeline.');
  });

  it.each([
    ['camelCase outside the dictionary', 'use stupid jargon here', 'Use StupidJargon here.', ['Voxloom']],
    ['a dictionary term the speaker said is dropped', 'Open WhisperKit now', 'Open now.', ['WhisperKit']],
    ['a dictionary term the speaker said loses its case', 'Open WhisperKit now', 'Open Whisperkit now.', ['WhisperKit']],
    ['a technical value in the dictionary', 'Use user_id', 'Use user_ids', ['user_id']],
    ['an invented dictionary term', 'Open the app', 'Open the WhisperKit app.', ['WhisperKit']],
    ['a near miss of the dictionary spelling', JARGON, 'You\'re making a lot of progress on the StupidJargons app.', ['StupidJargon']],
  ])('still rejects %s', (_name, raw, candidate, dictionary) => {
    expect(validateCleanupOutput(raw, candidate, dictionary)).toBeNull();
  });
});

describe('one pair of quotes around the whole output', () => {
  it.each([
    ['straight', `"${JARGON}"`],
    ['curly', `“${JARGON}”`],
  ])('is removed when the transcript was not quoted (%s)', (_name, candidate) => {
    expect(validateCleanupOutput(JARGON, candidate, ['StupidJargon'])).toBe(JARGON);
  });

  it('is removed before the dictionary join is checked', () => {
    expect(validateCleanupOutput(
      JARGON,
      '"You\'re making a lot of progress on the StupidJargon app."',
      ['StupidJargon'],
    )).toBe('You\'re making a lot of progress on the StupidJargon app.');
  });

  it('is kept when the transcript itself was quoted', () => {
    expect(validateCleanupOutput('"hello there"', '"Hello there."'))
      .toBe('"Hello there."');
  });

  it.each([
    ['only an opening quote', '"Send the report.'],
    ['only a closing quote', 'Send the report."'],
    ['two quotations', '"Send" the "report"'],
    ['mismatched marks', '“Send the report."'],
    ['single quotes', '\'Send the report.\''],
    ['quotes added inside', 'Send "the" report.'],
  ])('is not removed for %s', (_name, candidate) => {
    expect(validateCleanupOutput('send the report', candidate)).toBeNull();
  });

  it('does not hide a changed word inside the quotes', () => {
    expect(validateCleanupOutput('send the report', '"Send the summary."'))
      .toBeNull();
  });
});

describe('a standalone Okay sentence', () => {
  it('may be dropped from the dictation', () => {
    const cleaned = DICTATION.replace(/ Okay\.$/u, '');
    expect(validateCleanupOutput(DICTATION, cleaned, ['StupidJargon'])).toBe(cleaned);
  });

  it.each([
    ['ending the text without punctuation', 'Ship it today. okay', 'Ship it today.'],
    ['opening the text', 'Okay. Ship it today.', 'Ship it today.'],
    ['between sentences', 'Ship it. Okay! Then rest.', 'Ship it. Then rest.'],
    ['spelled OK', 'Ship it today. OK.', 'Ship it today.'],
  ])('may be dropped when %s', (_name, raw, candidate) => {
    expect(validateCleanupOutput(raw, candidate)).toBe(candidate);
  });

  it('may also be kept', () => {
    expect(validateCleanupOutput(DICTATION, DICTATION)).toBe(DICTATION);
  });

  it.each([
    ['mid-sentence', 'That is okay with me.', 'That is with me.'],
    ['opening a sentence', 'Okay, ship it.', 'Ship it.'],
    ['closing a sentence', 'Ship it, okay.', 'Ship it.'],
    ['a question', 'Ship it today. Okay?', 'Ship it today.'],
    ['inside a quotation', 'He said "Okay." and left.', 'He said "" and left.'],
    ['the whole transcript', 'Okay.', ''],
    ['replaced rather than dropped', 'Ship it today. Okay.', 'Ship it today. Fine.'],
  ])('is not droppable %s', (_name, raw, candidate) => {
    expect(validateCleanupOutput(raw, candidate)).toBeNull();
  });

  it('accepts a dictated Okay on its own', () => {
    expect(validateCleanupOutput('okay', 'Okay.')).toBe('Okay.');
  });
});

describe('meaning changes stay rejected', () => {
  it.each([
    ['accept → except', 'We can accept the invoice once legal signs off.', 'We can except the invoice once legal signs off.'],
    ['affect → effect', 'This change will affect the release date.', 'This change will effect the release date.'],
    ['sell → sail', 'Please sell the old laptops before Friday.', 'Please sail the old laptops before Friday.'],
    ['write → right', 'Ask the team to write the tests first.', 'Ask the team to right the tests first.'],
    ['fifty → fifteen', 'Cut the timeout from fifty to fifteen seconds.', 'Cut the timeout from fifteen to fifteen seconds.'],
    ['negation dropped', 'Please don\'t merge the branch until QA signs off.', 'Please do merge the branch until QA signs off.'],
    ['pronoun swapped', 'She said he would send the contract on Monday.', 'She said she would send the contract on Monday.'],
    ['amount reformatted', 'The invoice came to $1,250 which is 15% over budget.', 'The invoice came to $1250 which is 15% over budget.'],
    ['smirk → smoke', 'Can you run a smirk test on the new build before lunch?', 'Can you run a smoke test on the new build before lunch?'],
    ['quoted meaning change', 'We can accept the invoice.', '"We can except the invoice."'],
    ['dictionary over-repair', 'The queen visited the office today.', 'The Qwen visited the office today.'],
  ])('%s', (_name, raw, candidate) => {
    expect(validateCleanupOutput(raw, candidate, ['Qwen', 'StupidJargon'])).toBeNull();
  });
});
