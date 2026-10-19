import { describe, expect, it } from 'vitest';
import { cleanupImportNote, cleanupModelNote, endSentence } from '../../src/features/settings/cleanupCopy';

describe('cleanupImportNote (BUS-101)', () => {
  it('names the import failure without claiming the model was checked', () => {
    expect(cleanupImportNote('wrong file', false))
      .toBe('Couldn\'t import that file: wrong file.');
  });

  it('adds the unchanged-model sentence when a model is already installed', () => {
    expect(cleanupImportNote('wrong file', true))
      .toBe('Couldn\'t import that file: wrong file. Your current model is unchanged.');
  });
});

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
    expect(note('an import is already running.'))
      .toBe('Couldn\'t check the cleanup model: an import is already running.');
  });

  it('keeps a reason ending in ! or ?', () => {
    expect(note('disk gone!')).toBe('Couldn\'t check the cleanup model: disk gone!');
    expect(note('where is it?')).toBe('Couldn\'t check the cleanup model: where is it?');
  });
});

describe('cleanupImportNote punctuation (UI/UX period)', () => {
  it('does not double a period the reason already has', () => {
    expect(cleanupImportNote('an import is already running.', true))
      .toBe('Couldn\'t import that file: an import is already running. Your current model is unchanged.');
  });

  it('keeps a reason ending in ! or ?', () => {
    expect(cleanupImportNote('picker exploded!', false)).toBe('Couldn\'t import that file: picker exploded!');
    expect(cleanupImportNote('wrong file?', false)).toBe('Couldn\'t import that file: wrong file?');
  });
});
