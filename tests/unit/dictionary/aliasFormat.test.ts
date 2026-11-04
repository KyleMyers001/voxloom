// @vitest-environment node
// BUS-138 PR B: the optional `aliases` field in dictionary.json. The file stays
// version 1; files without it load unchanged and bad alias data is dropped
// piece by piece, never the whole file.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  createDictionaryStore,
  createMemoryDictionaryIo,
  defaultDictionaryFile,
  parseDictionaryJson,
  serializeDictionaryFile,
} from '../../../src/services/dictionary';
import { normalizeAliases } from '../../../src/services/dictionary/aliases';

const fixture = (name: string) =>
  readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8');

const load = (raw: string) => {
  const parsed = parseDictionaryJson(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.file;
};

describe('old files (no aliases field)', () => {
  it('load unchanged with empty aliases', () => {
    expect(load(fixture('dictionary-v1.json'))).toEqual({
      aliases: {},
      version: 1,
      words: ['Kubernetes', 'Postgres', 'Voxloom'],
    });
  });

  it('are written back byte for byte: no aliases key appears', () => {
    const raw = fixture('dictionary-v1.json');
    const file = load(raw);
    expect(serializeDictionaryFile(file.words, file.aliases)).toBe(raw);
    expect(serializeDictionaryFile(file.words)).toBe(raw);
  });

  it('the default file has empty aliases', () => {
    expect(defaultDictionaryFile()).toEqual({ aliases: {}, version: 1, words: [] });
  });
});

describe('new files', () => {
  it('load with their aliases and keep version 1', () => {
    const file = load(fixture('dictionary-v1-aliases.json'));
    expect(file.version).toBe(1);
    expect(file.aliases).toEqual({
      Kubernetes: ['cooper netties'],
      Voxloom: ['box loom', 'voks loom'],
    });
  });

  it('round-trip exactly', () => {
    const raw = fixture('dictionary-v1-aliases.json');
    const file = load(raw);
    expect(serializeDictionaryFile(file.words, file.aliases)).toBe(raw);
  });

  it('keep `words` a plain array of strings so older builds read it', () => {
    const written = JSON.parse(serializeDictionaryFile(['Voxloom'], { Voxloom: ['box loom'] }));
    expect(written.version).toBe(1);
    expect(written.words).toEqual(['Voxloom']);
    expect(Object.keys(written)).toEqual(['version', 'words', 'aliases']);
  });

  it('go through the store: save then load', async () => {
    const io = createMemoryDictionaryIo(null);
    const store = createDictionaryStore(io);
    await store.save(['Voxloom', 'Postgres'], { Voxloom: ['voks loom'] });
    const loaded = await store.load();
    expect(loaded.ok).toBe(true);
    expect(loaded.file.aliases).toEqual({ Voxloom: ['voks loom'] });
    await store.save(['Postgres'], { Voxloom: ['voks loom'] });
    expect(JSON.parse(io.snapshot()!).aliases).toBeUndefined();
  });

  it('still refuse another version', () => {
    expect(parseDictionaryJson(JSON.stringify({ aliases: {}, version: 2, words: [] })).ok).toBe(false);
  });
});

describe('bad alias data', () => {
  it('drops only the bad parts and still loads the file', () => {
    const file = load(fixture('dictionary-v1-bad-aliases.json'));
    expect(file.words).toEqual(['Kubernetes', 'Postgres', 'Skyloom', 'Voxloom']);
    // Words are processed in sorted order and a spelling is kept once, so
    // Postgres gets "voks loom" before Voxloom can. Dropped from Voxloom:
    // a number, a blank, a tab, its own word (VOXLOOM), another word
    // (Postgres), a common word (sky), a repeat (Box  Loom). "vox-loom" stays:
    // same letters as the word, different spacing, so it adds a match.
    expect(file.aliases).toEqual({
      Postgres: ['post gress', 'voks loom'],
      Skyloom: ['sky loom'],
      Voxloom: ['box loom', 'vox-loom'],
    });
  });

  it('ignores an aliases field that is not an object', () => {
    for (const aliases of [['a'], 'x', 3, null, true]) {
      const file = load(JSON.stringify({ aliases, version: 1, words: ['Voxloom'] }));
      expect(file.aliases).toEqual({});
      expect(file.words).toEqual(['Voxloom']);
    }
  });

  it('ignores aliases for a word that is not in the dictionary', () => {
    const file = load(JSON.stringify({ aliases: { Gone: ['x y'] }, version: 1, words: ['Voxloom'] }));
    expect(file.aliases).toEqual({});
  });

  it('matches the key to its word ignoring case and re-keys it to the saved casing', () => {
    const file = load(JSON.stringify({ aliases: { ' voxloom ': ['box loom'] }, version: 1, words: ['Voxloom'] }));
    expect(file.aliases).toEqual({ Voxloom: ['box loom'] });
  });

  it('keeps at most 8 aliases per word, in file order', () => {
    const many = Array.from({ length: 12 }, (_, index) => `alias word${String.fromCharCode(97 + index)}`);
    const file = load(JSON.stringify({ aliases: { Voxloom: many }, version: 1, words: ['Voxloom'] }));
    expect(file.aliases.Voxloom).toEqual(many.slice(0, 8));
  });

  it('drops an alias over 128 bytes and one holding a comma', () => {
    const file = load(JSON.stringify({
      aliases: { Voxloom: ['x'.repeat(129), 'a, b', `${'y'.repeat(60)} ${'z'.repeat(67)}`] },
      version: 1,
      words: ['Voxloom'],
    }));
    expect(file.aliases).toEqual({ Voxloom: [`${'y'.repeat(60)} ${'z'.repeat(67)}`] });
  });

  it('never throws on odd input and is idempotent', () => {
    for (const raw of [undefined, null, 5, 'x', [], {}, { Voxloom: 1 }, { Voxloom: [null, {}, []] }]) {
      const once = normalizeAliases(raw, ['Voxloom']);
      expect(normalizeAliases(once, ['Voxloom'])).toEqual(once);
    }
  });

  it('drops aliases when the file is serialised for a word that was removed', () => {
    const raw = serializeDictionaryFile(['Postgres'], { Voxloom: ['box loom'] });
    expect(JSON.parse(raw)).toEqual({ version: 1, words: ['Postgres'] });
  });
});

describe('a file with aliases read the way the previous build reads it', () => {
  // The previous build (main) validates `version`, takes only `words` and
  // writes back `{ version, words }`: it loads the words and drops the
  // aliases the next time it saves. This pins the part of the shape it needs.
  it('has a version 1 envelope whose `words` array is unchanged', () => {
    const raw = fixture('dictionary-v1-aliases.json');
    const parsed = JSON.parse(raw) as { version: number; words: unknown[] };
    expect(parsed.version).toBe(1);
    expect(parsed.words).toEqual(load(fixture('dictionary-v1.json')).words);
  });
});
