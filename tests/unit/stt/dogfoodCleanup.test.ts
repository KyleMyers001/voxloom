// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CleanupEngine } from '../../../src/services/cleanup/contracts';
import { DICTIONARY_MAX_BYTES, DICTIONARY_MAX_WORDS } from '../../../src/services/cleanup/prompt';
import { CLEANUP_MODEL_ID } from '../../../src/services/cleanup/types';
import { sortedWords } from '../../../src/services/dictionary/format';
import { prepareDogfoodCleanup } from '../../../src/services/stt/dogfoodCleanup';

const RAW = 'Send it.';

function prepare(dictionary: readonly string[], active = true) {
  const engine = {
    cancel: vi.fn().mockResolvedValue(undefined),
    run: vi.fn<CleanupEngine['run']>().mockResolvedValue(RAW),
  } satisfies CleanupEngine;
  const cleanup = prepareDogfoodCleanup({
    controller: new AbortController(),
    engine: () => engine,
    onStart: vi.fn(),
    requestId: 'cleanup-dictionary-test',
    settings: { active, dictionary, modelId: CLEANUP_MODEL_ID, style: 'casual' },
    userCancelled: () => false,
  });
  return { cleanup, engine };
}

function digest(words: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(words)).digest('hex');
}

function promptDictionary(prompt: string): string[] {
  const payload = JSON.parse(prompt.split('\n').at(-1)!) as { canonicalSpellings: string[] };
  return payload.canonicalSpellings;
}

describe('dogfood cleanup dictionary snapshot (BUS-198)', () => {
  it('keeps the newest words at the word limit in the request, prompt and provenance', async () => {
    const dictionary = Array.from({ length: DICTIONARY_MAX_WORDS + 2 }, (_, i) => `Word${String(i).padStart(3, '0')}`);
    const expected = dictionary.slice(-DICTIONARY_MAX_WORDS).reverse();
    const { cleanup, engine } = prepare(dictionary);

    const outcome = await cleanup.stage!(RAW);
    const request = engine.run.mock.calls[0][0];
    expect(request.dictionary).toEqual(expected);
    expect(promptDictionary(request.prompt)).toEqual(expected);
    expect(await cleanup.provenance(outcome)).toMatchObject({
      dictionaryDigest: digest(expected), status: 'cleaned',
    });
    expect(request.dictionary).not.toContain(dictionary[0]);
    expect(request.dictionary).not.toContain(dictionary[1]);
  });

  it('keeps newest entries when multibyte words hit the byte limit before the word limit', async () => {
    const dictionary = Array.from({ length: 20 }, (_, i) => `Term${String(i).padStart(3, '0')}${'é'.repeat(60)}`);
    const wordBytes = Buffer.byteLength(dictionary[0]);
    const count = Math.floor((DICTIONARY_MAX_BYTES + 2) / (wordBytes + 2));
    const expected = dictionary.slice(-count).reverse();
    const { cleanup, engine } = prepare(dictionary);

    const outcome = await cleanup.stage!(RAW);
    const request = engine.run.mock.calls[0][0];
    expect(count).toBeLessThan(DICTIONARY_MAX_WORDS);
    expect(request.dictionary).toEqual(expected);
    expect(Buffer.byteLength(request.dictionary.join(', '))).toBeLessThanOrEqual(DICTIONARY_MAX_BYTES);
    expect(Buffer.byteLength([...expected, dictionary[dictionary.length - count - 1]].join(', ')))
      .toBeGreaterThan(DICTIONARY_MAX_BYTES);
    expect(promptDictionary(request.prompt)).toEqual(expected);
    expect((await cleanup.provenance(outcome))?.dictionaryDigest).toBe(digest(expected));
  });

  it('uses stored addition order without mutating the dictionary or changing display sorting', async () => {
    const dictionary = Object.freeze(['Zulu', 'Alpha', 'Middle']);
    const { cleanup, engine } = prepare(dictionary);

    await cleanup.stage!(RAW);
    expect(engine.run.mock.calls[0][0].dictionary).toEqual(['Middle', 'Alpha', 'Zulu']);
    expect(sortedWords(dictionary)).toEqual(['Alpha', 'Middle', 'Zulu']);
    expect(dictionary).toEqual(['Zulu', 'Alpha', 'Middle']);
  });

  it('freezes the selected dictionary before later edits for both cleanup and History', async () => {
    const dictionary = ['Zulu', 'Alpha'];
    const { cleanup, engine } = prepare(dictionary);
    dictionary.push('Newest');
    dictionary[0] = 'Edited';

    const outcome = await cleanup.stage!(RAW);
    const expected = ['Alpha', 'Zulu'];
    expect(engine.run.mock.calls[0][0].dictionary).toEqual(expected);
    expect((await cleanup.provenance(outcome))?.dictionaryDigest).toBe(digest(expected));
  });

  it('keeps the latest casing while preserving snapshot trimming and deduplication', async () => {
    const { cleanup, engine } = prepare(['Voxloom', ' Notion ', 'VOXLOOM', ' ']);

    await cleanup.stage!(RAW);
    expect(engine.run.mock.calls[0][0].dictionary).toEqual(['VOXLOOM', 'Notion']);
  });

  it('keeps an empty dictionary empty in the prompt and provenance', async () => {
    const { cleanup, engine } = prepare([]);

    const outcome = await cleanup.stage!(RAW);
    const request = engine.run.mock.calls[0][0];
    expect(request.dictionary).toEqual([]);
    expect(promptDictionary(request.prompt)).toEqual([]);
    expect(await cleanup.provenance(outcome)).toMatchObject({
      dictionaryDigest: digest([]), promptVersion: 'cleanup-v2',
    });
  });

  it('does not run cleanup or generate provenance when cleanup is off', async () => {
    const { cleanup, engine } = prepare(['Zulu', 'Alpha'], false);

    expect(cleanup.stage).toBeUndefined();
    expect(await cleanup.provenance(undefined)).toBeUndefined();
    expect(engine.run).not.toHaveBeenCalled();
  });
});
