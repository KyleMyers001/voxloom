// @vitest-environment node
// BUS-138 PR B2, review round 1: the exact-letter join must not change what
// was said, and must not rewrite identifiers or code.
import { describe, expect, it } from 'vitest';

import { replaceDictionaryTerms } from '../../../src/services/dictionary/replace';

const fix = (text: string, words: string[] = ['Voxloom']) =>
  replaceDictionaryTerms(text, words);

describe('negation and pronouns are never part of a joined word', () => {
  it.each([
    'Use atom, not ion.',
    'It is no tion.',
    'Do not ion it.',
    'Never ion this.',
  ])('leaves "%s" as said', (text) => {
    expect(fix(text, ['Notion'])).toBe(text);
  });

  it('leaves a pronoun run alone and still joins around it', () => {
    expect(fix('Open my cell now.', ['Mycell'])).toBe('Open my cell now.');
    expect(fix('Open vox loom, not ion.', ['Voxloom', 'Notion']))
      .toBe('Open Voxloom, not ion.');
  });

  it('still joins a split with no such word in it', () => {
    expect(fix('Open noti on now.', ['Notion'])).toBe('Open Notion now.');
  });
});

describe('identifiers and code are not rewritten', () => {
  it.each([
    'Run vox-loom-cli now.',
    'Run vox loom-cli now.',
    'Run my-vox-loom now.',
    'Run `vox loom` now.',
    'Run `vox-loom` now.',
    'Run ```vox loom``` now.',
    'See `a` and `vox loom` here.',
  ])('leaves "%s" alone', (text) => {
    expect(fix(text)).toBe(text);
  });

  it('joins again after the code span closes', () => {
    expect(fix('Run `ls` then vox loom.')).toBe('Run `ls` then Voxloom.');
    expect(fix('Say vox loom - then go.')).toBe('Say Voxloom - then go.');
  });

  it('settles: a second pass changes nothing', () => {
    const once = fix('Open vox loom, `vox loom` and vox-loom-cli.');
    expect(once).toBe('Open Voxloom, `vox loom` and vox-loom-cli.');
    expect(fix(once)).toBe(once);
  });
});
