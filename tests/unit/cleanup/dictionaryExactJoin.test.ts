// @vitest-environment node
// BUS-138 PR B2: an exact two-word join is accepted exactly as on main
// (d2d4ee9), including when an article or filler is one of the two words, and
// whichever side of it the model keeps the spoken words. Found by a
// differential run against main; the new three-word join must not change that.
import { describe, expect, it } from 'vitest';

import { validateCleanupOutput } from '../../../src/services/cleanup/validation';

const check = (raw: string, out: string, dictionary: string[]) =>
  validateCleanupOutput(raw, out, dictionary);

describe('two words that spell an entry exactly', () => {
  it.each([
    ['an thropic', 'Anthropic', ['Anthropic']],
    ['We use an thropic today.', 'We use Anthropic today.', ['Anthropic']],
    ['a pple pie', 'Apple pie', ['Apple']],
    ['Ask the zentrix team', 'Ask the Zentrix team', ['Zentrix']],
    ['Um grafana is down', 'Um Grafana is down', ['Grafana']],
    ['an thropic', 'an thropic', ['Anthropic']],
  ])('accepts "%s" → "%s"', (raw, out, dictionary) => {
    expect(check(raw, out, dictionary)).toBe(out);
  });

  it('accepts a common-word entry spelled by its exact join (ap ple → Apple)', () => {
    expect(check('Open ap ple now.', 'Open Apple now.', ['Apple'])).toBe('Open Apple now.');
  });

  it('still rejects a common-word entry as the repair of another word', () => {
    expect(check('Open apply now.', 'Open Apple now.', ['Apple'])).toBeNull();
  });
});

describe('three words with an article or filler in them are as on main', () => {
  it.each([
    ['Please open a n thropic now.', 'Please open A n thropic now.'],
    ['Please open a n thropic now.', 'Please open a n thropic now.'],
    ['an t hropic and more.', 't hropic and more.'],
    ['an t hropic and more.', 'an t hropic and more.'],
  ])('keeps "%s" → "%s"', (raw, out) => {
    expect(check(raw, out, ['Anthropic'])).toBe(out);
  });

  it('still joins three plain words', () => {
    expect(check('Open vo xlo om now.', 'Open Voxloom now.', ['Voxloom']))
      .toBe('Open Voxloom now.');
  });
});

describe('the negation skip is not part of the output check', () => {
  it('does not touch the article an', () => {
    expect(check('Use an thropic.', 'Use Anthropic.', ['Anthropic'])).toBe('Use Anthropic.');
  });
});
