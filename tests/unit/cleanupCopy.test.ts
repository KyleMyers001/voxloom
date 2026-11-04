import { describe, expect, it } from 'vitest';
import { cleanupModelNote, endSentence } from '../../src/features/settings/cleanupCopy';

describe('endSentence (UI/UX: one closing period, never "..")', () => {
  it('adds a period to a bare reason', () => {
    expect(endSentence('denied')).toBe('denied.');
  });

  it('keeps existing terminal punctuation and trims trailing whitespace', () => {
    expect(endSentence('already running.')).toBe('already running.');
    expect(endSentence('picker exploded!  ')).toBe('picker exploded!');
    expect(endSentence('is it there?\n')).toBe('is it there?');
    expect(endSentence('denied \t')).toBe('denied.');
  });
});

describe('cleanupModelNote error (UI/UX period)', () => {
  const note = (message: string) => cleanupModelNote({ kind: 'error', message });

  it('ends a bare reason with a period', () => {
    expect(note('denied')).toBe('Couldn\'t check the cleanup model: denied.');
  });

  it('does not double a period the reason already has', () => {
    expect(note('a download is already running.'))
      .toBe('Couldn\'t check the cleanup model: a download is already running.');
  });

  it('keeps a reason ending in ! or ?', () => {
    expect(note('disk gone!')).toBe('Couldn\'t check the cleanup model: disk gone!');
    expect(note('where is it?')).toBe('Couldn\'t check the cleanup model: where is it?');
  });
});
