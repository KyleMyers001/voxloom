import { describe, expect, it } from 'vitest';
import { appReducer, createInitialState } from '../../src/app/state';
import { canRetry } from '../../src/domain/records';

describe('appReducer', () => {
  it('adds one record and rejects a duplicate completion', () => {
    const initial = createInitialState(1_000);
    const listening = appReducer(initial, { type: 'start-dictation' });
    const processing = appReducer(listening, {
      completion: 'held',
      runId: 1,
      type: 'process-dictation',
    });
    const complete = appReducer(processing, {
      now: 2_000,
      runId: 1,
      type: 'complete-dictation',
    });
    const duplicate = appReducer(complete, {
      now: 3_000,
      runId: 1,
      type: 'complete-dictation',
    });
    expect(complete.records).toHaveLength(initial.records.length + 1);
    expect(duplicate).toBe(complete);
  });

  it('does not create success after cancellation', () => {
    const initial = createInitialState(1_000);
    const listening = appReducer(initial, { type: 'start-dictation' });
    const cancelled = appReducer(listening, {
      runId: 1,
      type: 'cancel-dictation',
    });
    const completion = appReducer(cancelled, {
      now: 2_000,
      runId: 1,
      type: 'complete-dictation',
    });
    expect(completion).toBe(cancelled);
  });

  it('uses the supplied time to guard retry expiry', () => {
    const state = createInitialState(10_000);
    const failed = state.records.find((record) => record.status === 'failed');
    expect(failed).toBeDefined();
    if (!failed?.recoveryExpiresAt) return;
    expect(canRetry(failed, failed.recoveryExpiresAt - 1)).toBe(true);
    expect(canRetry(failed, failed.recoveryExpiresAt)).toBe(false);
    expect(appReducer(state, {
      id: failed.id,
      now: failed.recoveryExpiresAt,
      type: 'retry',
    })).toBe(state);
  });

  it('resolves a retry source without duplicating history', () => {
    const initial = createInitialState(10_000);
    const failed = initial.records.find((record) =>
      record.status === 'failed'
    );
    if (!failed) throw new Error('fixture failure missing');
    const retrying = appReducer(initial, {
      id: failed.id,
      now: 10_001,
      type: 'retry',
    });
    const complete = appReducer(retrying, {
      now: 10_100,
      runId: 1,
      type: 'complete-dictation',
    });
    expect(complete.records).toHaveLength(initial.records.length);
    expect(complete.records.find(({ id }) => id === failed.id)?.status)
      .toBe('inserted');
    expect(appReducer(complete, {
      now: 10_200,
      runId: 1,
      type: 'complete-dictation',
    })).toBe(complete);
  });

  it('guards retry terminals and permits retry after cancel', () => {
    const initial = createInitialState(10_000);
    const failed = initial.records.find((record) =>
      record.status === 'failed'
    );
    if (!failed) throw new Error('fixture failure missing');
    const retrying = appReducer(initial, {
      id: failed.id,
      now: 10_001,
      type: 'retry',
    });
    const staleActions = [
      { now: 10_002, runId: 99, type: 'fail-dictation' },
      { now: 10_002, runId: 99, type: 'complete-dictation' },
      { runId: 99, type: 'cancel-dictation' },
    ] as const;
    for (const action of staleActions) {
      expect(appReducer(retrying, action)).toBe(retrying);
    }
    const cancelled = appReducer(retrying, {
      runId: 1,
      type: 'cancel-dictation',
    });
    const repeated = appReducer(cancelled, {
      id: failed.id,
      now: 10_003,
      type: 'retry',
    });
    expect(repeated.dictation).toMatchObject({
      retrySourceId: failed.id,
      runId: 2,
    });
  });

  it('does not replace an active listening run with a retry', () => {
    const initial = createInitialState(10_000);
    const failed = initial.records.find((record) =>
      record.status === 'failed'
    );
    if (!failed) throw new Error('fixture failure missing');
    const listening = appReducer(initial, { type: 'start-dictation' });
    const result = appReducer(listening, {
      id: failed.id,
      now: 10_001,
      type: 'retry',
    });
    expect(result).toBe(listening);
    expect(result.dictation).toMatchObject({ kind: 'listening', runId: 1 });
  });

  it(
    'reopens setup transient state while preserving session permission',
    () => {
      const initial = createInitialState(10_000);
      const configured = {
        ...initial,
        onboarding: {
          complete: true,
          holdTested: true,
          microphoneGranted: true,
          permissionDenied: true,
          recognizedText: 'fixture',
          shortcutCollision: true,
          step: 3 as const,
          tapTested: true,
        },
      };
      const reopened = appReducer(configured, { type: 'reopen-onboarding' });
      expect(reopened.onboarding).toEqual({
        complete: true,
        holdTested: false,
        microphoneGranted: true,
        permissionDenied: false,
        recognizedText: '',
        shortcutCollision: false,
        step: 1,
        tapTested: false,
      });
      const reset = appReducer(configured, { now: 20_000, type: 'reset' });
      expect(reset.onboarding.microphoneGranted).toBe(false);
      expect(reset.onboarding.complete).toBe(false);
    },
  );

  it('prepends an append-record dogfood history row', () => {
    const initial = createInitialState(1_000);
    const record = {
      createdAt: 2_000,
      durationSeconds: 3,
      id: 'dogfood-pcm-x',
      model: 'whisper-tiny.en',
      recoveryExpiresAt: null,
      status: 'copied' as const,
      style: 'formal' as const,
      text: 'session history from dogfood',
    };
    const next = appReducer(initial, { record, type: 'append-record' });
    expect(next.records[0]).toEqual(record);
    expect(next.records).toHaveLength(initial.records.length + 1);
  });

  it('hydrates durable records and clears history errors', () => {
    const initial = createInitialState(1_000, { persistHistory: true });
    expect(initial.records).toEqual([]);
    const errored = appReducer(initial, {
      message: 'boom',
      type: 'set-history-error',
    });
    const row = {
      createdAt: 3_000,
      durationSeconds: 1,
      id: 'persisted-1',
      model: null,
      recoveryExpiresAt: null,
      status: 'copied' as const,
      style: 'casual' as const,
      text: 'from disk',
    };
    const hydrated = appReducer(errored, {
      records: [row],
      now: Date.now(), type: 'hydrate-records',
    });
    expect(hydrated.records).toEqual([row]);
    expect(hydrated.historyError).toBeNull();
  });

  it('preserves durable records on reset when persistHistory is on', () => {
    const row = {
      createdAt: 3_000,
      durationSeconds: 1,
      id: 'durable-keep',
      model: 'whisper-tiny.en',
      recoveryExpiresAt: null,
      status: 'copied' as const,
      style: 'formal' as const,
      text: 'keep me',
    };
    const hydrated = appReducer(
      createInitialState(1_000, { persistHistory: true }),
      { records: [row], now: Date.now(), type: 'hydrate-records' },
    );
    const configured = {
      ...hydrated,
      onboarding: { ...hydrated.onboarding, complete: true },
      screen: 'history' as const,
    };
    const reset = appReducer(configured, {
      now: 20_000,
      persistHistory: true,
      type: 'reset',
    });
    expect(reset.onboarding.complete).toBe(false);
    expect(reset.screen).toBe('home');
    expect(reset.records).toEqual([row]);
    expect(reset.records.map((r) => r.id)).not.toContain('record-1');
  });

  it('wipes durable records on reset only when wipeHistory is set', () => {
    const row = {
      createdAt: 3_000,
      durationSeconds: 1,
      id: 'durable-wipe',
      model: null,
      recoveryExpiresAt: null,
      status: 'copied' as const,
      style: 'casual' as const,
      text: 'wipe me',
    };
    const hydrated = appReducer(
      createInitialState(1_000, { persistHistory: true }),
      { records: [row], now: Date.now(), type: 'hydrate-records' },
    );
    const wiped = appReducer(hydrated, {
      now: 20_000,
      persistHistory: true,
      type: 'reset',
      wipeHistory: true,
    });
    expect(wiped.records).toEqual([]);
    expect(wiped.records.map((r) => r.id)).not.toContain('record-1');
  });

  it('reseeds fixture history on reset when persistence is off', () => {
    const emptied = appReducer(createInitialState(1_000), {
      type: 'scenario-empty',
    });
    expect(emptied.records).toEqual([]);
    const reset = appReducer(emptied, { now: 20_000, type: 'reset' });
    expect(reset.records.length).toBeGreaterThan(0);
    expect(reset.records.some((r) => r.id === 'record-1')).toBe(true);
  });

});

  it('hydrates durable settings and clears settings errors', () => {
    const initial = createInitialState(1_000, { persistSettings: true });
    const errored = appReducer(initial, {
      message: 'settings boom',
      type: 'set-settings-error',
    });
    const nextSettings = {
      ...initial.settings,
      appearance: 'dark' as const,
      transcriptRetention: 'forever' as const,
    };
    const hydrated = appReducer(errored, {
      onboardingComplete: true,
      settings: nextSettings,
      now: Date.now(), type: 'hydrate-settings',
    });
    expect(hydrated.settings).toEqual(nextSettings);
    expect(hydrated.onboarding.complete).toBe(true);
    expect(hydrated.settingsError).toBeNull();
  });

  it('preserves durable settings on reset when persistSettings is on', () => {
    const configured = {
      ...createInitialState(1_000, { persistSettings: true }),
      onboarding: {
        ...createInitialState(1_000).onboarding,
        complete: true,
      },
      settings: {
        ...createInitialState(1_000).settings,
        style: 'casual' as const,
        transcriptRetention: 'forever' as const,
      },
    };
    const reset = appReducer(configured, {
      now: 20_000,
      persistSettings: true,
      type: 'reset',
    });
    expect(reset.settings.transcriptRetention).toBe('forever');
    expect(reset.settings.style).toBe('casual');
    expect(reset.onboarding.complete).toBe(true);
  });


  it('hydrates durable dictionary words and clears dictionary errors', () => {
    const initial = createInitialState(1_000, { persistDictionary: true });
    expect(initial.words).toEqual([]);
    const errored = appReducer(initial, {
      message: 'dictionary boom',
      type: 'set-dictionary-error',
    });
    const hydrated = appReducer(errored, {
      type: 'hydrate-words',
      words: ['Persisted'],
    });
    expect(hydrated.words).toEqual(['Persisted']);
    expect(hydrated.dictionaryError).toBeNull();
  });

  it('preserves durable dictionary words on reset when persistDictionary is on', () => {
    const hydrated = appReducer(
      createInitialState(1_000, { persistDictionary: true }),
      { type: 'hydrate-words', words: ['KeepMe'] },
    );
    const reset = appReducer(hydrated, {
      now: 20_000,
      persistDictionary: true,
      type: 'reset',
    });
    expect(reset.words).toEqual(['KeepMe']);
  });

