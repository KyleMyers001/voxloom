// @vitest-environment node
// BUS-138 PR B: validating the "Also heard as" text before it is saved.
import { describe, expect, it } from 'vitest';

import {
  splitAliasInput,
  validateAliases,
  validateWordAgainstAliases,
} from '../../../src/services/dictionary/aliases';

const WORDS = ['Kubernetes', 'Postgres', 'Voxloom'];
const ALIASES = { Postgres: ['post gress'], Voxloom: ['box loom'] };

const check = (input: string, word = 'Tauri', editing?: string, words = WORDS, aliases = ALIASES) =>
  validateAliases(input, word, words, aliases, editing);

const error = (input: string, word?: string, editing?: string) => {
  const result = check(input, word, editing);
  if (result.ok) throw new Error(`expected an error for ${input}`);
  return result.error;
};

describe('splitting the field', () => {
  it('splits on commas, trims and drops blanks', () => {
    expect(splitAliasInput(' tory ,, tauri  ,')).toEqual(['tory', 'tauri']);
    expect(splitAliasInput('')).toEqual([]);
    expect(splitAliasInput('  ')).toEqual([]);
  });
});

describe('valid aliases', () => {
  it('accepts an empty field', () => {
    expect(check('')).toEqual({ aliases: [], ok: true });
  });

  it('keeps the entered order and the entered spelling', () => {
    expect(check('Tory, tor ee')).toEqual({ aliases: ['Tory', 'tor ee'], ok: true });
  });

  it('allows letters that differ from the word (the mapping is explicit)', () => {
    expect(check('sky lume, skylum', 'Skyloom')).toEqual({ aliases: ['sky lume', 'skylum'], ok: true });
  });

  it('allows a phrase made of common words', () => {
    expect(check('sky loom', 'Skylark').ok).toBe(true);
    expect(check('will you', 'Wilma').ok).toBe(true);
  });

  it('allows the entry\'s own aliases again when editing it', () => {
    expect(check('box loom, voks loom', 'Voxloom', 'Voxloom')).toEqual({ aliases: ['box loom', 'voks loom'], ok: true });
  });

  it('allows aliases to move with a renamed word', () => {
    expect(check('box loom', 'Voxloom 2', 'Voxloom').ok).toBe(true);
  });
});

describe('errors', () => {
  it('rejects a control character, naming the alias rule', () => {
    expect(error('vox\tloom')).toBe('An alias can\'t contain tabs, line breaks or other control characters.');
    expect(error('a\u0085b')).toMatch(/control characters/);
  });

  it('rejects an alias that is too long', () => {
    expect(error('x'.repeat(129))).toBe('"' + 'x'.repeat(129) + '" is too long for an alias.');
    expect(check('x'.repeat(128)).ok).toBe(true);
    expect(error('é'.repeat(65))).toMatch(/too long/);
  });

  it('rejects more than 8 aliases', () => {
    const nine = Array.from({ length: 9 }, (_, index) => `alias ${String.fromCharCode(97 + index)}`).join(', ');
    expect(error(nine)).toBe('A word can have up to 8 aliases.');
    expect(check(nine.split(', ').slice(0, 8).join(', ')).ok).toBe(true);
  });

  it('rejects the word itself, ignoring case, spacing and hyphens', () => {
    expect(error('tauri', 'Tauri')).toBe('"tauri" is the word itself.');
    expect(error('VOXLOOM', 'Voxloom')).toBe('"VOXLOOM" is the word itself.');
    expect(error('vox-loom', 'VoxLoom')).toBe('"vox-loom" is the word itself.');
  });

  it('allows the word\'s own letters with different spacing (the engine splits a compound)', () => {
    expect(check('vox loom, voks loom', 'Voxloom', 'Voxloom')).toEqual({ aliases: ['vox loom', 'voks loom'], ok: true });
  });

  it('allows a spaced spelling of the word, once', () => {
    expect(check('vox loom', 'Voxloom', 'Voxloom')).toEqual({ aliases: ['vox loom'], ok: true });
    expect(error('vox loom, VOX-LOOM', 'Voxloom', 'Voxloom')).toBe('"VOX-LOOM" is listed twice.');
  });

  it('still rejects a spaced spelling that belongs to another word', () => {
    expect(error('post gres', 'Voxloom')).toBe('"post gres" is already in your dictionary.');
    expect(error('box-loom', 'Skyloom')).toBe('"box-loom" is already an alias of Voxloom.');
  });

  it('rejects another word, ignoring case and spacing', () => {
    expect(error('post-gres')).toBe('"post-gres" is already in your dictionary.');
    expect(error('KUBERNETES')).toBe('"KUBERNETES" is already in your dictionary.');
  });

  it('rejects another word\'s alias, naming the word', () => {
    expect(error('Box Loom')).toBe('"Box Loom" is already an alias of Voxloom.');
    expect(error('boxloom')).toBe('"boxloom" is already an alias of Voxloom.');
  });

  it('rejects a repeat inside the same field', () => {
    expect(error('tory, Tory')).toBe('"Tory" is listed twice.');
    expect(error('to ry, to-ry')).toBe('"to-ry" is listed twice.');
  });

  it('rejects a single common word', () => {
    expect(error('sky', 'Skyloom')).toBe('"sky" is a common word and would change ordinary speech. Use a longer phrase.');
    expect(error('Will', 'Wilma')).toMatch(/common word/);
    expect(error('tory, the')).toMatch(/"the" is a common word/);
  });

  it('rejects hyphen shapes the matcher cannot read back', () => {
    for (const alias of ['-sky', 'sky-', 'a - b', 'a--b']) {
      expect(error(alias), alias).toBe(`"${alias}" has a hyphen or spacing that can't be matched. Use single hyphens or spaces between words.`);
    }
  });

  it('reports the first problem in field order', () => {
    expect(error('vox\tloom, sky')).toMatch(/control characters/);
    expect(error('sky, box loom')).toMatch(/"sky" is a common word/);
  });

  it('does not count a word being renamed away as taken', () => {
    expect(check('voxloom', 'Voxloom 2', 'Voxloom').ok).toBe(true);
  });
});

describe('a new word against existing aliases', () => {
  it('rejects a word that is another word\'s alias', () => {
    const result = validateWordAgainstAliases('Box Loom', ALIASES);
    expect(result).toEqual({ error: '"Box Loom" is already an alias of Voxloom.', ok: false });
  });

  it('allows it when it is the same word\'s own alias (editing)', () => {
    expect(validateWordAgainstAliases('Box Loom', ALIASES, 'Voxloom')).toEqual({ ok: true });
  });

  it('allows an unrelated word', () => {
    expect(validateWordAgainstAliases('Tauri', ALIASES)).toEqual({ ok: true });
  });
});
