import { describe, expect, it } from 'vitest';
import type { DictationRecord } from '../../src/domain/types';
import {
  RETENTION_30_DAYS_MS,
  applyTranscriptRetention,
  createHistoryStore,
  createMemoryHistoryIo,
  parseHistoryJson,
  serializeHistoryFile,
} from '../../src/services/history';

function sample(overrides: Partial<DictationRecord> = {}): DictationRecord {
  return {
    createdAt: 1_000,
    durationSeconds: 2,
    id: 'r1',
    model: 'whisper-tiny.en',
    rawText: overrides.text ?? 'hello',
    cleanup: {
      dictionaryDigest: null, dictionaryVersion: 1,
      modelDigest: null, modelId: null, promptVersion: 'cleanup-v1',
      reason: null, status: 'skipped',
    },
    recoveryExpiresAt: null,
    status: 'copied',
    style: 'formal',
    text: 'hello',
    ...overrides,
  };
}

describe('parseHistoryJson', () => {
  it('round-trips optional BUS-23 rawText and rejects a non-string rawText', () => {
    const row = sample({ rawText: '[Music] hello' });
    const parsed = parseHistoryJson(serializeHistoryFile([row]));
    expect(parsed).toEqual({ file: { records: [row], version: 2 }, ok: true, sourceVersion: 2 });

    const bad = JSON.stringify({ records: [{ ...sample(), rawText: 5 }], version: 1 });
    const badParsed = parseHistoryJson(bad);
    expect(badParsed.ok && badParsed.file.records).toEqual([]);
  });

  it('round-trips the may-have-inserted flag on Unverified rows (Review #44)', () => {
    const row = sample({ mayHaveInserted: { copied: true }, status: 'unverified' });
    expect(parseHistoryJson(serializeHistoryFile([row]))).toEqual({ file: { records: [row], version: 2 }, ok: true, sourceVersion: 2 });
  });

  it('applies transcript retention to rows carrying rawText', () => {
    const row = sample({ rawText: '[Music] hello' });
    expect(applyTranscriptRetention([row], 'off', Date.now())).toEqual([]);
  });

  it('preserves unverified delivery rather than claiming insertion or dropping recovery text', () => {
    const row = sample({ status: 'unverified' });
    const parsed = parseHistoryJson(serializeHistoryFile([row]));
    expect(parsed).toEqual({ file: { records: [row], version: 2 }, ok: true, sourceVersion: 2 });
  });

  it('accepts a valid v2 document', () => {
    const raw = serializeHistoryFile([sample()]);
    const parsed = parseHistoryJson(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.records).toHaveLength(1);
    expect(parsed.file.records[0]?.text).toBe('hello');
  });

  it('migrates v1 text to raw and final with skipped provenance', () => {
    const parsed = parseHistoryJson(JSON.stringify({
      records: [sample()],
      version: 1,
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.records[0]).toMatchObject({
      cleanup: { status: 'skipped' },
      rawText: 'hello',
      text: 'hello',
    });
  });

  it.each([
    undefined, null, 'unknown', [],
    { status: 'future-status' },
    { dictionaryVersion: 2 },
    { status: ['cleaned'] },
    { modelId: null, modelDigest: 'digest-without-model' },
  ])('preserves v2 text across unreadable cleanup metadata %#', async (metadata) => {
    const valid = {
      dictionaryDigest: null, dictionaryVersion: 1,
      modelDigest: null, modelId: null, promptVersion: 'cleanup-v1',
      reason: null, status: 'skipped',
    };
    const cleanup = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? { ...valid, ...metadata } : metadata;
    const row = { ...sample(), rawText: 'original words', text: 'Final words.', cleanup };
    const io = createMemoryHistoryIo(JSON.stringify({ version: 2, records: [row] }));
    const store = createHistoryStore(io);
    const loaded = await store.load('forever', 1);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0]).toMatchObject({
      rawText: 'original words', text: 'Final words.', status: 'copied',
      cleanup: { status: 'unavailable', modelId: null, modelDigest: null },
    });
    await store.save(loaded.records, 'forever', 1);
    expect(await store.load('forever', 1)).toEqual(loaded);
    await store.save(loaded.records, 'off', 1);
    expect(await store.load('forever', 1)).toEqual({ ok: true, records: [] });
  });

  it('rejects corrupt JSON without inventing an empty store', () => {
    const parsed = parseHistoryJson('{not-json');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/not valid JSON/i);
  });

  it('rejects unknown versions', () => {
    const parsed = parseHistoryJson(JSON.stringify({
      records: [],
      version: 99,
    }));
    expect(parsed.ok).toBe(false);
  });

  it('skips invalid rows inside a valid envelope', () => {
    const parsed = parseHistoryJson(JSON.stringify({
      records: [sample(), { id: 'bad' }, sample({ id: 'r2', text: 'ok' })],
      version: 1,
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.records.map((r) => r.id)).toEqual(['r1', 'r2']);
  });
});

describe('applyTranscriptRetention', () => {
  it('clears all rows when retention is off', () => {
    expect(applyTranscriptRetention([sample()], 'off', 10_000)).toEqual([]);
  });

  it('drops rows older than 30 days', () => {
    const now = 1_000_000_000_000;
    const kept = sample({ createdAt: now - 1_000, id: 'new' });
    const dropped = sample({
      createdAt: now - RETENTION_30_DAYS_MS - 1,
      id: 'old',
    });
    expect(
      applyTranscriptRetention([kept, dropped], '30-days', now).map((r) =>
        r.id
      ),
    ).toEqual(['new']);
  });

  it('keeps all rows when retention is forever', () => {
    const rows = [sample(), sample({ id: 'r2' })];
    expect(applyTranscriptRetention(rows, 'forever', 99)).toEqual(rows);
  });
});

describe('createHistoryStore', () => {
  it('loads missing file as empty', async () => {
    const store = createHistoryStore(createMemoryHistoryIo(null));
    const result = await store.load('forever', 1);
    expect(result).toEqual({ ok: true, records: [] });
  });

  it('round-trips save then load', async () => {
    const io = createMemoryHistoryIo(null);
    const store = createHistoryStore(io);
    const rows = [sample({ id: 'a' }), sample({ id: 'b', text: 'two' })];
    await store.save(rows, 'forever', 1);
    const loaded = await store.load('forever', 1);
    expect(loaded).toMatchObject({
      ok: true,
      records: rows.map((row) => ({ ...row, rawText: row.text })),
    });
    expect(io.snapshot()).toContain('"version": 2');
  });

  it('delete path: save without a row removes it from disk', async () => {
    const io = createMemoryHistoryIo(null);
    const store = createHistoryStore(io);
    await store.save([sample({ id: 'keep' }), sample({ id: 'gone' })], 'forever', 1);
    await store.save([sample({ id: 'keep' })], 'forever', 1);
    const loaded = await store.load('forever', 1);
    expect(loaded.ok && loaded.records.map((r) => r.id)).toEqual(['keep']);
  });

  it('does not write when load fails on corrupt bytes', async () => {
    const io = createMemoryHistoryIo('{corrupt');
    const store = createHistoryStore(io);
    const loaded = await store.load('forever', 1);
    expect(loaded.ok).toBe(false);
    expect(io.snapshot()).toBe('{corrupt');
  });

  it('honors retention off on save (empty durable file)', async () => {
    const io = createMemoryHistoryIo(null);
    const store = createHistoryStore(io);
    await store.save([sample()], 'off', 1);
    const loaded = await store.load('forever', 1);
    expect(loaded).toEqual({ ok: true, records: [] });
  });
});
