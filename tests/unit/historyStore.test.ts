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
    recoveryExpiresAt: null,
    status: 'copied',
    style: 'formal',
    text: 'hello',
    ...overrides,
  };
}

describe('parseHistoryJson', () => {
  it('accepts a valid v1 document', () => {
    const raw = serializeHistoryFile([sample()]);
    const parsed = parseHistoryJson(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.records).toHaveLength(1);
    expect(parsed.file.records[0]?.text).toBe('hello');
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
    expect(loaded).toEqual({ ok: true, records: rows });
    expect(io.snapshot()).toContain('"version": 1');
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
