import { describe, expect, it } from 'vitest';
import { cleanupImportNote } from '../../src/features/settings/cleanupCopy';

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
