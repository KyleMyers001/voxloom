// @vitest-environment node
// BUS-138 PR B2: a dictionary word heard as two or three words that spell it
// exactly is joined, with or without cleanup.
import { describe, expect, it } from 'vitest';

import { replaceDictionaryTerms } from '../../../src/services/dictionary/replace';

const fix = (text: string, words: string[] = ['Voxloom']) =>
  replaceDictionaryTerms(text, words);

describe('joining split words', () => {
  it.each([
    ['open vox loom now', 'open Voxloom now'],
    ['open Vox Loom now', 'open Voxloom now'],
    ['open VOX LOOM now', 'open Voxloom now'],
    ['open vox-loom now', 'open Voxloom now'],
    ['open vox  loom now', 'open Voxloom now'],
    ['open vox\tloom now', 'open Voxloom now'],
    ['vox loom is ready', 'Voxloom is ready'],
    ['ask vox loom', 'ask Voxloom'],
    ['vox loom, vox loom.', 'Voxloom, Voxloom.'],
    ['"vox loom" (vox loom)', '"Voxloom" (Voxloom)'],
    ['vox loom\'s menu', 'Voxloom\'s menu'],
  ])('joins "%s"', (heard, spelled) => {
    expect(fix(heard)).toBe(spelled);
  });

  it('joins three words, and a longer match wins', () => {
    expect(fix('a vo xlo om here')).toBe('a Voxloom here');
    expect(fix('a vox loom er', ['Voxloom', 'Voxloomer'])).toBe('a Voxloomer');
    expect(fix('a vox loom is', ['Voxloom', 'Voxloomer'])).toBe('a Voxloom is');
    expect(fix('stupid jar gon app', ['StupidJargon'])).toBe('StupidJargon app');
  });

  it('joins an exact multi-case entry written as one word', () => {
    expect(fix('use whisper kit', ['WhisperKit'])).toBe('use WhisperKit');
  });

  it('is idempotent and returns the same text when nothing joins', () => {
    const once = fix('open vox loom and vox-loom');
    expect(once).toBe('open Voxloom and Voxloom');
    expect(fix(once)).toBe(once);
    const same = 'the box loom is here';
    expect(fix(same)).toBe(same);
  });

  it('never joins letters that differ, so sound-alikes are the model\'s call', () => {
    expect(fix('open box loom')).toBe('open box loom');
    expect(fix('open vox looms')).toBe('open vox looms');
    expect(fix('open vox lum')).toBe('open vox lum');
  });

  it('does not join across punctuation, a line break or another word', () => {
    expect(fix('I like vox. Loom is fine')).toBe('I like vox. Loom is fine');
    expect(fix('vox, loom')).toBe('vox, loom');
    expect(fix('vox\nloom')).toBe('vox\nloom');
    expect(fix('vox "loom"')).toBe('vox "loom"');
    expect(fix('vox - loom')).toBe('vox - loom');
    expect(fix('vox and loom')).toBe('vox and loom');
  });

  it('leaves code-like text, flags and identifiers alone', () => {
    for (const text of [
      'src/vox loom', 'vox loom.app', 'vox loom/readme', '--vox-loom', 'vox_loom',
      '$vox loom', 'vox loom=1', '@vox loom', 'vox2 loom', 'vox loom2',
    ]) expect(fix(text)).toBe(text);
  });

  it('does not start inside a contraction or continue a longer word', () => {
    expect(fix('it\'s vox loom')).toBe('it\'s Voxloom');
    expect(fix('l\'vox loom')).toBe('l\'vox loom');
    expect(fix('vox loomer')).toBe('vox loomer');
    expect(fix('avox loom')).toBe('avox loom');
  });

  it('never joins pieces of one letter, or only common words', () => {
    expect(fix('e bay', ['eBay'])).toBe('e bay');
    expect(fix('any one', ['Anyone'])).toBe('any one');
    expect(fix('any way', ['Anyway'])).toBe('any way');
    expect(fix('sky loom', ['Skyloom'])).toBe('Skyloom');
  });

  it('ignores entries it cannot read back, and short or common entries', () => {
    expect(fix('chat gpt', ['--verbose'])).toBe('chat gpt');
    expect(fix('to day', ['Today'])).toBe('to day');
    expect(fix('vo x', ['Vox'])).toBe('vo x');
  });

  it('settles next to another entry, in both orders', () => {
    const words = ['Voxloom', 'AskChat'];
    const once = fix('vox loom ask chat and ask chat vox loom', words);
    expect(once).toBe('Voxloom AskChat and AskChat Voxloom');
    expect(fix(once, words)).toBe(once);
  });

  it('works with no dictionary or no text', () => {
    expect(fix('vox loom', [])).toBe('vox loom');
    expect(fix('')).toBe('');
  });
});
