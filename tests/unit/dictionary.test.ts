import { describe, expect, it } from 'vitest';
import { validateWord } from '../../src/domain/dictionary';

describe('validateWord', () => {
  it('trims a valid word', () => {
    expect(validateWord('  Vite  ', ['TypeScript'])).toEqual({
      ok: true,
      word: 'Vite',
    });
  });

  it('rejects blanks and case-insensitive duplicates', () => {
    expect(validateWord('  ', [])).toEqual({
      error: 'Enter a word.',
      ok: false,
    });
    expect(validateWord('typescript', ['TypeScript'])).toEqual({
      error: 'typescript is already in your dictionary.',
      ok: false,
    });
  });

  it('allows edit-to-same-word (including case-only change)', () => {
    expect(validateWord('TypeScript', ['TypeScript'], 'TypeScript')).toEqual({
      ok: true,
      word: 'TypeScript',
    });
    expect(validateWord('typescript', ['TypeScript'], 'TypeScript')).toEqual({
      ok: true,
      word: 'typescript',
    });
  });

  it('rejects tabs, line breaks and control characters inside a word', () => {
    const error = 'A word can\'t contain tabs, line breaks or other control characters.';
    for (const value of ['Vite\tJS', 'Vite\nJS', 'Vite\r\nJS', 'Vi\u0000te', 'Vi\u001bte', 'Vi\u007fte',
      'Vi\u0080te', 'Vi\u0085te', 'Vi\u009fte', 'Vi\u2028te', 'Vi\u2029te']) {
      expect(validateWord(value, [])).toEqual({ error, ok: false });
    }
  });

  it('still trims a tab, newline or separator at either end', () => {
    expect(validateWord('\tVite\n', [])).toEqual({ ok: true, word: 'Vite' });
    expect(validateWord('\u2028Vite\u2029', [])).toEqual({ ok: true, word: 'Vite' });
  });

  it('rejects a C1 control even at the edge, where trimming does not remove it', () => {
    for (const value of ['\u0085Vite', 'Vite\u009f', '\u0080']) {
      expect(validateWord(value, []).ok, JSON.stringify(value)).toBe(false);
    }
  });

  it('allows spaces, hyphens, accents and symbols', () => {
    expect(validateWord('Chat-GPT 4 Café C++', [])).toEqual({
      ok: true,
      word: 'Chat-GPT 4 Café C++',
    });
  });
});
