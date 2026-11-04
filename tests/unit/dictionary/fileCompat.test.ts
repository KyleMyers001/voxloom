// @vitest-environment node
// BUS-138 PR B2 changed how dictionary words are used, not how they are
// stored. A dictionary.json written by the previous version must load
// unchanged, and saving must write the same format back.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { createMemoryDictionaryIo } from '../../../src/services/dictionary/io';
import { createDictionaryStore } from '../../../src/services/dictionary/store';
import { digestDictionary } from '../../../src/services/cleanup/prompt';

const previous = readFileSync(
  new URL('../../fixtures/dictionary-v1.json', import.meta.url), 'utf8',
);

describe('dictionary.json written by the previous version', () => {
  it('loads with every word and no error', async () => {
    const store = createDictionaryStore(createMemoryDictionaryIo(previous));
    const result = await store.load();
    expect(result).toEqual({
      file: { version: 1, words: ['Kubernetes', 'Notion', 'Q3', 'Voxloom', 'Zoë'] },
      ok: true,
    });
  });

  it('saves the same bytes back, with no new fields', async () => {
    const io = createMemoryDictionaryIo(previous);
    const store = createDictionaryStore(io);
    const loaded = await store.load();
    if (!loaded.ok) throw new Error('fixture must load');
    await store.save(loaded.file.words);
    expect(io.snapshot()).toBe(previous);
  });

  it('keeps the dictionary digest of history rows unchanged', async () => {
    // The digest covers the words only, never the prompt text, so history rows
    // written before B2 still compare equal to rows written after it.
    expect(await digestDictionary(['Voxloom', 'Notion'])).toBe('8d401803465c0497cef2f13e39b75a87185cff9c2b8fae7bb277875e155f94e0');
  });
});
