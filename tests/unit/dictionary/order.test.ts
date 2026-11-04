// BUS-196: the dictionary keeps the order words were added (oldest first) so
// Whisper's prompt can take the newest first. The Dictionary screen and the
// cleanup stage still see an alphabetical list.
import { describe, expect, it } from 'vitest';
import { appReducer, createInitialState } from '../../../src/app/state';
import {
  newestFirst,
  normalizeWords,
  parseDictionaryJson,
  serializeDictionaryFile,
  sortedWords,
} from '../../../src/services/dictionary/format';

function add(words: string[], ...more: string[]): string[] {
  return more.reduce(
    (state, word) => appReducer(state, { type: 'save-word', word }),
    { ...createInitialState(1_000), words },
  ).words;
}

describe('saving a word', () => {
  it('appends it, so the newest word is last', () => {
    expect(add(['Zed', 'Alpha'], 'Mango', 'Beta')).toEqual(['Zed', 'Alpha', 'Mango', 'Beta']);
  });

  it('moves an edited word to the end as the newest', () => {
    const state = appReducer(
      { ...createInitialState(1_000), words: ['Alpha', 'Beta', 'Gamma'] },
      { editing: 'Alpha', type: 'save-word', word: 'Alphas' },
    );
    expect(state.words).toEqual(['Beta', 'Gamma', 'Alphas']);
  });
});

describe('dictionary.json', () => {
  it('keeps the stored order on load and save', () => {
    const json = serializeDictionaryFile(['Zed', 'alpha', 'Mango']);
    expect(JSON.parse(json)).toEqual({ version: 1, words: ['Zed', 'alpha', 'Mango'] });
    const parsed = parseDictionaryJson(json);
    expect(parsed.ok && parsed.file.words).toEqual(['Zed', 'alpha', 'Mango']);
  });

  it('loads an older alphabetical file as it is, still de-duplicated', () => {
    const old = JSON.stringify({ version: 1, words: ['Alpha', 'alpha', 'Beta', ' Gamma '] });
    const parsed = parseDictionaryJson(old);
    expect(parsed.ok && parsed.file.words).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('normalizeWords drops bad entries without reordering', () => {
    expect(normalizeWords(['b', 3, '', 'a', 'B'])).toEqual(['b', 'a']);
  });
});

describe('views of the stored order', () => {
  const stored = ['Zed', 'mango', 'Alpha', 'beta'];

  it('sortedWords is alphabetical and leaves the input alone', () => {
    expect(sortedWords(stored)).toEqual(['Alpha', 'beta', 'mango', 'Zed']);
    expect(stored).toEqual(['Zed', 'mango', 'Alpha', 'beta']);
  });

  it('newestFirst reverses it and leaves the input alone', () => {
    expect(newestFirst(stored)).toEqual(['beta', 'Alpha', 'mango', 'Zed']);
    expect(stored).toEqual(['Zed', 'mango', 'Alpha', 'beta']);
  });
});
