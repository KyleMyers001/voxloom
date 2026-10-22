import { describe, expect, it } from 'vitest';
import { snapshotDictionary } from '../../../src/services/cleanup/prompt';
import { validateCleanupOutput } from '../../../src/services/cleanup/validation';

// Follow-ups from the #122 review (CR and QA nits, mutants M5 and M19).

describe('a standalone Okay sentence (follow-ups)', () => {
  it.each([
    ['before an ellipsis and more words', 'Okay... so we ship it.', 'So we ship it.'],
    ['before a Unicode ellipsis and more words', 'Okay… so we ship it.', 'So we ship it.'],
    ['ending the text with an ellipsis', 'Ship it today. Okay...', 'Ship it today.'],
    ['ending the text with a Unicode ellipsis', 'Ship it today. Okay…', 'Ship it today.'],
    ['after a Unicode ellipsis', 'Ship it today… Okay.', 'Ship it today…'],
    ['before trailing whitespace', 'Ship it today. Okay. ', 'Ship it today.'],
  ])('may be dropped %s', (_name, raw, candidate) => {
    expect(validateCleanupOutput(raw, candidate)).toBe(candidate);
  });

  // M19: the sentence must end at a space or the end of the text.
  it.each([
    ['a period with no following space', 'Ship it today. Okay.Then rest.', 'Ship it today. Then rest.'],
    ['a Unicode ellipsis with no following space', 'Ship it today. Okay…Then rest.', 'Ship it today. Then rest.'],
    ['a trailing comma', 'Ship it today. Okay,', 'Ship it today.'],
    ['an ellipsis question', 'Ship it today. Okay…?', 'Ship it today.'],
    // Unpunctuated with trailing whitespace stays content today (a known gap).
    ['unpunctuated before trailing whitespace', 'Ship it today. Okay ', 'Ship it today.'],
  ])('is not droppable before %s', (_name, raw, candidate) => {
    expect(validateCleanupOutput(raw, candidate)).toBeNull();
  });
});

describe('whole-output quotes followed by a period', () => {
  it.each([
    ['straight', '"Send the report".'],
    ['curly', '“Send the report”.'],
  ])('are removed and the period moves inside (%s)', (_name, candidate) => {
    expect(validateCleanupOutput('send the report', candidate)).toBe('Send the report.');
  });

  it('does not double a period the quoted text already has', () => {
    expect(validateCleanupOutput('send the report', '"Send the report.".'))
      .toBe('Send the report.');
  });

  it('keeps a question mark the quoted text ends with', () => {
    expect(validateCleanupOutput('send the report?', '"Send the report?".'))
      .toBe('Send the report?');
  });

  it('are kept when the transcript itself was quoted', () => {
    expect(validateCleanupOutput('"send the report".', '"Send the report".'))
      .toBe('"Send the report".');
  });

  it.each([
    ['a changed word inside', '"Send the summary".'],
    ['another quotation inside', '"Send "the" report".'],
    ['mismatched marks', '“Send the report".'],
    ['an exclamation mark outside', '"Send the report"!'],
    ['a comma outside', '"Send the report",'],
    ['two periods outside', '"Send the report"..'],
  ])('are not removed with %s', (_name, candidate) => {
    expect(validateCleanupOutput('send the report', candidate)).toBeNull();
  });
});

// M5: padding inside the removed pair is trimmed from the delivered text.
describe('padding inside removed quotes', () => {
  it.each([
    ['without a trailing period', '" Send the report. "'],
    ['with a trailing period', '" Send the report ".'],
  ])('is trimmed %s', (_name, candidate) => {
    expect(validateCleanupOutput('send the report', candidate)).toBe('Send the report.');
  });
});

// runCleanup trims dictionary terms with snapshotDictionary before the guard.
describe('dictionary terms', () => {
  it('are trimmed before the guard sees them', () => {
    const dictionary = snapshotDictionary(['  StupidJargon  ']);
    const ideal = 'We ship the StupidJargon app.';
    expect(validateCleanupOutput('We ship the stupid jargon app.', ideal, dictionary))
      .toBe(ideal);
  });
});
