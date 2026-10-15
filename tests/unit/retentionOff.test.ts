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
    const next = appReducer(forever, { key: 'transcriptRetention', now: 5_000, type: 'set-setting', value: 'off' });
    expect(next.settings.transcriptRetention).toBe('off');
    expect(next.records.map((r) => r.id)).toEqual(['b']);
  });

  it('leaves records alone for other retention changes', () => {
    const next = appReducer(forever, { key: 'transcriptRetention', now: 5_000, type: 'set-setting', value: '30-days' });
    expect(next.records).toHaveLength(3);
  });
});

describe('retention Off: expiry and cross-window (BUS-78)', () => {
  const now = 5_000;
  const base = createInitialState(1_000);
  const forever = {
    ...base,
    records: [rec('a', 'inserted', null), rec('b', 'failed', now + 60_000)],
    settings: { ...base.settings, transcriptRetention: 'forever' as const },
  };

  it('drops a failed row whose recovery window has ended (expire-recovery)', () => {
    const expired = appReducer(forever, { now, type: 'expire-recovery' });
    const next = appReducer(expired, { key: 'transcriptRetention', now, type: 'set-setting', value: 'off' });
    expect(next.records).toEqual([]);
  });

  it('clears records when Off arrives from the Settings window (hydrate-settings)', () => {
    const next = appReducer(forever, {
      onboardingComplete: true,
      settings: { ...forever.settings, transcriptRetention: 'off' },
      now,
      type: 'hydrate-settings',
    });
    expect(next.settings.transcriptRetention).toBe('off');
    expect(next.records.map((r) => r.id)).toEqual(['b']);
  });

  it('hydrate-settings with other retention keeps records', () => {
    const next = appReducer(forever, {
      onboardingComplete: true,
      settings: { ...forever.settings, style: 'casual' },
      now,
      type: 'hydrate-settings',
    });
    expect(next.records).toHaveLength(2);
  });
});

describe('retention Off uses the action clock (BUS-78)', () => {
  const base = createInitialState(1_000);
  const forever = {
    ...base,
    records: [rec('b', 'failed', 9_999)],
    settings: { ...base.settings, transcriptRetention: 'forever' as const },
  };
  it('keeps a failed row before its expiry and drops it after', () => {
    const off = { key: 'transcriptRetention', type: 'set-setting', value: 'off' } as const;
    expect(appReducer(forever, { ...off, now: 9_998 }).records).toHaveLength(1);
    expect(appReducer(forever, { ...off, now: 10_000 }).records).toHaveLength(0);
  });
});

describe('Off before the first history load (BUS-78)', () => {
  it('hydrate-records after Off keeps only recoverable failed rows', () => {
    const base = createInitialState(1_000);
    const off = appReducer(
      { ...base, records: [], settings: { ...base.settings, transcriptRetention: 'forever' } },
      {
        now: 5_000,
        onboardingComplete: true,
        settings: { ...base.settings, transcriptRetention: 'off' },
        type: 'hydrate-settings',
      },
    );
    const loaded = appReducer(off, {
      now: 5_000,
      records: [rec('a', 'inserted', null), rec('b', 'failed', 9_999), rec('c', 'failed', 4_000)],
      type: 'hydrate-records',
    });
    expect(loaded.records.map((r) => r.id)).toEqual(['b']);
  });
});

describe('Retention Off rollback restores records (BUS-78 P1)', () => {
  const now = 5_000;
  const base = createInitialState(1_000);
  const forever = {
    ...base,
    records: [rec('a', 'inserted', null), rec('b', 'failed', now + 60_000)],
    settings: { ...base.settings, transcriptRetention: 'forever' as const },
  };

  it('restores transcripts Off cleared when the settings save rolls back', () => {
    const off = appReducer(forever, { key: 'transcriptRetention', now, type: 'set-setting', value: 'off' });
    expect(off.records.map((r) => r.id)).toEqual(['b']);
    const withNew = appReducer(off, { record: rec('n', 'inserted', null), type: 'append-record' });
    const rolled = appReducer(withNew, {
      onboardingComplete: true, now, rollback: true, settings: forever.settings, type: 'hydrate-settings',
    });
    expect(rolled.settings.transcriptRetention).toBe('forever');
    expect(rolled.records.map((r) => r.id)).toEqual(['n', 'a', 'b']);
    expect(rolled.retentionOffStash).toBeNull();
  });

  it('does not restore once Off saved, nor on a non-rollback change away from Off', () => {
    const off = appReducer(forever, { key: 'transcriptRetention', now, type: 'set-setting', value: 'off' });
    const saved = appReducer(off, { type: 'settings-saved' });
    const rolled = appReducer(saved, {
      onboardingComplete: true, now, rollback: true, settings: forever.settings, type: 'hydrate-settings',
    });
    expect(rolled.records.map((r) => r.id)).toEqual(['b']);
    const foreign = appReducer(off, {
      onboardingComplete: true, now, settings: forever.settings, type: 'hydrate-settings',
    });
    expect(foreign.records.map((r) => r.id)).toEqual(['b']);
  });
});
