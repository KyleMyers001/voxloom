import { describe, expect, it } from 'vitest';
import { appReducer, createInitialState } from '../../src/app/state';
import type { DictationRecord } from '../../src/domain/types';

function rec(id: string, status: DictationRecord['status'], recovery: number | null) {
  const base = createInitialState(1_000).records[0];
  return { ...base, id, recoveryExpiresAt: recovery, status } as DictationRecord;
}

describe('transcript retention Off (BUS-78)', () => {
  const start = {
    ...createInitialState(1_000),
    records: [rec('a', 'inserted', null), rec('b', 'failed', 9_999), rec('c', 'failed', null)],
  };
  const forever = { ...start, settings: { ...start.settings, transcriptRetention: 'forever' as const } };

  it('clears loaded transcripts except a recoverable failed row', () => {
    const next = appReducer(forever, { key: 'transcriptRetention', type: 'set-setting', value: 'off' });
    expect(next.settings.transcriptRetention).toBe('off');
    expect(next.records.map((r) => r.id)).toEqual(['b']);
  });

  it('leaves records alone for other retention changes', () => {
    const next = appReducer(forever, { key: 'transcriptRetention', type: 'set-setting', value: '30-days' });
    expect(next.records).toHaveLength(3);
  });
});
