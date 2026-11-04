// @vitest-environment node
// BUS-138 PR B2, review round 1: words that look alike (two edits apart),
// entries that are plain words, hyphenated text kept as spoken, inflections,
// and the cost on long input.
import { describe, expect, it } from 'vitest';

import { validateCleanupOutput } from '../../../src/services/cleanup/validation';

const check = (raw: string, out: string, dictionary: string[]) =>
  validateCleanupOutput(raw, out, dictionary);

describe('one spoken word gets one edit, never two', () => {
  it.each([
    ['Foxloon', 'Voxloom'],
    ['Granada', 'Grafana'],
    ['Anthropoid', 'Anthropic'],
  ])('keeps %s apart from %s', (spoken, entry) => {
    expect(check(`Ask ${spoken} to call.`, `Ask ${entry} to call.`, [entry])).toBeNull();
    expect(check(`Ask ${spoken} to call.`, `Ask ${spoken} to call.`, [entry]))
      .toBe(`Ask ${spoken} to call.`);
  });

  it('still allows one edit on a long word and two across several words', () => {
    expect(check('Ask Voxlom to go.', 'Ask Voxloom to go.', ['Voxloom']))
      .toBe('Ask Voxloom to go.');
    expect(check('Ask box looms to go.', 'Ask Voxloom to go.', ['Voxloom']))
      .toBe('Ask Voxloom to go.');
  });
});

describe('an entry that is a plain common word', () => {
  it('is never the repair of a look-alike word', () => {
    expect(check('Please apply it.', 'Please Apple it.', ['Apple'])).toBeNull();
    expect(check('Please apply it.', 'Please apply it.', ['Apple']))
      .toBe('Please apply it.');
  });
});

describe('hyphenated words kept as spoken', () => {
  it.each([
    'Open box-loom now.',
    'The box-loom tool.',
    'Open my-box-loom thing.',
    'Open box-loom, then close it.',
  ])('accepts %s unchanged', (text) => {
    expect(check(text, text, ['Voxloom'])).toBe(text);
  });

  it('still rejects a mark that moves off the words', () => {
    expect(check('Open box-loom now.', 'Open boxloom-now.', ['Voxloom'])).toBeNull();
  });
});

describe('an inflection or a one-letter slip is not a mishearing', () => {
  it.each([
    ['Postgress', 'Postgres'],
    ['Terraforme', 'Terraform'],
    ['Notions', 'Notion'],
  ])('rejects %s → %s', (spoken, entry) => {
    expect(check(`We use ${spoken} daily.`, `We use ${entry} daily.`, [entry])).toBeNull();
  });

  it('rejects a multi-word fix followed by a quote that moves', () => {
    expect(check('Open box loom and say "hi".', 'Open Voxloom and say "hi".', ['Voxloom']))
      .toBeNull();
  });
});
