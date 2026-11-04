// @vitest-environment node
// BUS-138 PR B2: the output check lets 1 to 3 source words stand for one
// dictionary spelling. It is a permission only: the model decides, so every
// fix case also checks that leaving the spoken words alone still passes.
import { describe, expect, it } from 'vitest';

import { validateCleanupOutput } from '../../../src/services/cleanup/validation';
import { withinEdits } from '../../../src/services/cleanup/dictionarySpans';

const VOX = ['Voxloom'];
const check = (raw: string, out: string, dictionary: string[] = VOX) =>
  validateCleanupOutput(raw, out, dictionary);

describe('withinEdits', () => {
  it.each([
    ['voxloom', 'voxloom', 0, true],
    ['boxloom', 'voxloom', 1, true],
    ['voxlom', 'voxloom', 1, true],
    ['voxlooms', 'voxloom', 1, true],
    ['boxlooms', 'voxloom', 1, false],
    ['boxlooms', 'voxloom', 2, true],
    ['loom', 'voxloom', 2, false],
    ['notion', 'motions', 1, false],
  ])('%s vs %s within %i edit(s): %s', (left, right, max, expected) => {
    expect(withinEdits(left, right, max)).toBe(expected);
  });
});

describe('split words that sound like a dictionary word', () => {
  it.each([
    ['Send it to box loom.', 'Send it to Voxloom.'],
    ['Fox loom should open when I press the shortcut.',
      'Voxloom should open when I press the shortcut.'],
    ['Open vox lom now.', 'Open Voxloom now.'],
    ['Open box looms now.', 'Open Voxloom now.'],
    ['Open Box Loom now.', 'Open Voxloom now.'],
  ])('accepts the fix %s → %s', (raw, fixed) => {
    expect(check(raw, fixed)).toBe(fixed);
    expect(check(raw, raw)).toBe(raw);
  });

  it('accepts three spoken words, and two edits only for several words', () => {
    expect(check('The stupid jar gin app.', 'The StupidJargon app.', ['StupidJargon']))
      .toBe('The StupidJargon app.');
    expect(check('Open Foxlomm now.', 'Open Voxloom now.')).toBeNull();
    expect(check('Open box looms now.', 'Open Voxloom now.')).toBe('Open Voxloom now.');
    // Notion is 6 letters: one edit only.
    expect(check('Ship the mocion.', 'Ship the Notion.', ['Notion'])).toBeNull();
    expect(check('Ship the motion.', 'Ship the Notion.', ['Notion']))
      .toBe('Ship the Notion.');
  });

  it('accepts the fix next to marks that do not move', () => {
    expect(check('Did you open box loom?', 'Did you open Voxloom?'))
      .toBe('Did you open Voxloom?');
    expect(check('Open box loom, then close it.', 'Open Voxloom, then close it.'))
      .toBe('Open Voxloom, then close it.');
    expect(check('Open box loom! Fast.', 'Open Voxloom! Fast.'))
      .toBe('Open Voxloom! Fast.');
  });

  it('accepts the exact spelling only, never a half fix or a snapped word', () => {
    for (const out of [
      'Open voxloom now.', 'Open VOXLOOM now.', 'Open Vox loom now.',
      'Open Vox-loom now.', 'Open VoxLoom now.', 'Open Voxloom Voxloom now.',
    ]) expect(check('Open box loom now.', out)).toBeNull();
    expect(check('Open box loom now.', 'Open Voxloom now.')).toBe('Open Voxloom now.');
    expect(check('Open box loom now.', 'Open box loom now.')).toBe('Open box loom now.');
  });

  it('leaves a hyphenated word to the deterministic join, which runs after', () => {
    // A hyphenated word is a protected value, so the model may not rewrite it.
    expect(check('Open box-loom now.', 'Open Voxloom now.')).toBeNull();
    expect(check('Open vox-loom now.', 'Open vox-loom now.')).toBe('Open vox-loom now.');
  });

  it('keeps the exact join (vox loom) working', () => {
    expect(check('Send to vox loom.', 'Send to Voxloom.')).toBe('Send to Voxloom.');
    expect(check('Send to vox loom.', 'Send to vox loom.')).toBe('Send to vox loom.');
    expect(check('Send to vox loom.', 'Send to voxloom.')).toBeNull();
  });

  it('allows a filler or article to be dropped around the span', () => {
    expect(check('Um open the box loom.', 'Open Voxloom.')).toBe('Open Voxloom.');
  });
});

describe('rejects a swap that is not a dictionary fix', () => {
  it('rejects a change of only the ending (an inflection)', () => {
    expect(check('Open voxlooms.', 'Open Voxloom.')).toBeNull();
    expect(check('Open voxloomer.', 'Open Voxloom.')).toBeNull();
    expect(check('Open voxloom.', 'Open Voxlooms.')).toBeNull();
    expect(check('Ship notions.', 'Ship Notion.', ['Notion'])).toBeNull();
    expect(check('Ship notion.', 'Ship Notions.', ['Notion'])).toBeNull();
    expect(check('Open box loom ing.', 'Open Voxlooming.')).toBeNull();
  });

  it('rejects extra words folded into the dictionary word', () => {
    expect(check('Send to vox loom.', 'Send Voxloom.')).toBeNull();
    expect(check('Vox is loom.', 'Voxloom.')).toBeNull();
    expect(check('Open vox of loom.', 'Open Voxloom.')).toBeNull();
    expect(check('Open to box loom.', 'Open Voxloom.')).toBeNull();
    expect(check('Open box loom now.', 'Open Voxloom.')).toBeNull();
  });

  it('never turns a plain common word into a dictionary word', () => {
    // state is one edit from Stage, and a plain word, so it stays.
    expect(check('The state is ready.', 'The Stage is ready.', ['Stage'])).toBeNull();
    expect(check('The state is ready.', 'The state is ready.', ['Stage']))
      .toBe('The state is ready.');
    expect(check('The sound is low.', 'The Sounds is low.', ['Sounds'])).toBeNull();
    // Words that are not on the common list still repair (motion → Notion).
    expect(check('Open the motion.', 'Open the Notion.', ['Notion']))
      .toBe('Open the Notion.');
  });

  it('rejects when two dictionary words match', () => {
    const both = ['Notion', 'Motion'];
    expect(check('Open the potion.', 'Open the Notion.', both)).toBeNull();
    expect(check('Open the potion.', 'Open the Motion.', both)).toBeNull();
    expect(check('Open the potion.', 'Open the potion.', both))
      .toBe('Open the potion.');
    const twoSplits = ['Voxloom', 'Foxloom'];
    expect(check('Open box loom.', 'Open Voxloom.', twoSplits)).toBeNull();
    expect(check('Open box loom.', 'Open Foxloom.', twoSplits)).toBeNull();
  });

  it('rejects the fix with no dictionary word, or a dictionary of other words', () => {
    expect(check('Open box loom.', 'Open Voxloom.', [])).toBeNull();
    expect(check('Open box loom.', 'Open Voxloom.', ['Notion'])).toBeNull();
    expect(check('Open box loom.', 'Open Voxloom.', ['Vox'])).toBeNull();
  });

  it('does not join across sentence punctuation, quotes or a line break', () => {
    expect(check('I use box. Loom is nice.', 'I use Voxloom is nice.')).toBeNull();
    expect(check('I use box, loom is nice.', 'I use Voxloom is nice.')).toBeNull();
    expect(check('She said box "loom".', 'She said "Voxloom".')).toBeNull();
    expect(check('Open box\nloom now.', 'Open Voxloom now.')).toBeNull();
    // The text itself is still fine as it was.
    expect(check('I use box. Loom is nice.', 'I use box. Loom is nice.'))
      .toBe('I use box. Loom is nice.');
  });

  it('keeps technical values and quotes protected', () => {
    expect(check('Open src/box loom now.', 'Open src/Voxloom now.')).toBeNull();
    expect(check('Open box_loom now.', 'Open Voxloom now.')).toBeNull();
    expect(check('Open box.loom now.', 'Open Voxloom now.')).toBeNull();
    expect(check('Open box loom.app now.', 'Open Voxloom.app now.')).toBeNull();
    expect(check('Open box loom2 now.', 'Open Voxloom2 now.')).toBeNull();
    expect(check('She said "box loom" today.', 'She said "Voxloom" today.')).toBeNull();
    expect(check('She said "box loom" today.', 'She said "box loom" today.'))
      .toBe('She said "box loom" today.');
  });

  it('keeps negation and pronouns', () => {
    expect(check('Do not open box loom.', 'Open Voxloom.')).toBeNull();
    expect(check('I open box loom.', 'Open Voxloom.')).toBeNull();
  });
});

describe('real words that look like the dictionary word', () => {
  it('passes only when the model leaves them alone', () => {
    for (const sentence of [
      'The box looms large.', 'A loom and a box.', 'Open the box.',
      'He bought a loom.', 'The fox looms near.',
    ]) expect(check(sentence, sentence)).toBe(sentence);
  });

  it('is a permission, so the guard alone does not block a close fix', () => {
    // Two edits from Voxloom: the prompt tells the model to leave it alone
    // unless the sentence is about Voxloom; the guard cannot judge that.
    expect(check('The box looms large.', 'The Voxloom large.')).toBe('The Voxloom large.');
  });

  it('keeps a real word that is one edit from a dictionary word unless it is a fix', () => {
    expect(check('A vox popular.', 'A vox popular.')).toBe('A vox popular.');
    expect(check('Skyline view.', 'Skyline view.', ['Skylane'])).toBe('Skyline view.');
  });
});
