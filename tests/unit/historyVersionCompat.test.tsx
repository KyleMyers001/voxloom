// BUS-42: history.json written as version 2 by the BUS-16 cleanup branch
// (#24) was rejected ("Unsupported history file version: 2"), so History
// came up empty. Older/sibling versions must load (after a backup), and an
// unreadable / unknown-version file must never be overwritten.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppProvider, useApp } from '../../src/app/AppContext';
import { initialSettings } from '../../src/domain/fixtures';
import type { DictationRecord } from '../../src/domain/types';
import {
  createDictionaryStore,
  createMemoryDictionaryIo,
} from '../../src/services/dictionary';
import {
  createHistoryStore,
  createMemoryHistoryIo,
  parseHistoryJson,
} from '../../src/services/history';
import {
  createMemorySettingsIo,
  createSettingsStore,
  serializeSettingsFile,
} from '../../src/services/settings';

const V2 = readFileSync(join(__dirname, '../fixtures/history-v2.json'), 'utf8');
const NOW = 1_800_000_000_000;

const newRow: DictationRecord = {
  createdAt: NOW - 10,
  durationSeconds: 1,
  id: 'new-after-boot',
  model: 'whisper-tiny.en',
  recoveryExpiresAt: null,
  status: 'inserted',
  style: 'formal',
  text: 'new',
};

let api: ReturnType<typeof useApp> | null = null;
function Probe() {
  api = useApp();
  return null;
}

function boot(historyIo: ReturnType<typeof createMemoryHistoryIo>) {
  api = null;
  return render(
    <AppProvider
      clock={() => NOW}
      historyPersistence={{ enabled: true, store: createHistoryStore(historyIo) }}
      settingsPersistence={{
        enabled: true,
        store: createSettingsStore(
          createMemorySettingsIo(serializeSettingsFile(initialSettings, true)),
        ),
      }}
    >
      <Probe />
    </AppProvider>,
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe('BUS-42 history file version compatibility', () => {
  it('parses the v2 fixture, keeping rawText and ignoring cleanup provenance', () => {
    const parsed = parseHistoryJson(V2);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.sourceVersion).toBe(2);
    expect(parsed.file.records.map((r) => [r.id, r.rawText, r.text])).toEqual([
      ['v2-cleaned', 'um so the meeting is at three', 'The meeting is at three.'],
      ['v2-legacy', 'hello world', 'hello world'],
    ]);
    expect(parsed.file.records[0]).not.toHaveProperty('cleanup');
  });

  it('store backs up a v2 file before reporting it migratable', async () => {
    const io = createMemoryHistoryIo(V2);
    const result = await createHistoryStore(io).load('forever', NOW);
    expect(result).toMatchObject({ migratedFrom: 2, ok: true });
    expect(io.backups()).toEqual([V2]);
    expect(io.snapshot()).toBe(V2);
  });

  it('store refuses to migrate a v2 file it cannot back up', async () => {
    const io = createMemoryHistoryIo(V2);
    const noBackup = { read: io.read, write: io.write };
    const result = await createHistoryStore(noBackup).load('forever', NOW);
    expect(result.ok).toBe(false);
  });

  it('app boots with v2 history, shows it, and only then rewrites it as v1', async () => {
    const io = createMemoryHistoryIo(V2);
    boot(io);
    await waitFor(() => expect(api?.bootReady).toBe(true));
    await settle();
    expect(api!.state.historyError).toBeNull();
    expect(api!.state.records.map((r) => r.id)).toEqual(['v2-cleaned', 'v2-legacy']);
    expect(io.backups()).toEqual([V2]);

    act(() => api!.dispatch({ record: newRow, type: 'append-record' }));
    await waitFor(() => expect(io.snapshot() ?? '').toContain('new-after-boot'));
    const disk = JSON.parse(io.snapshot()!) as { records: { id: string }[]; version: number };
    expect(disk.version).toBe(1);
    expect(disk.records.map((r) => r.id).sort()).toEqual(
      ['new-after-boot', 'v2-cleaned', 'v2-legacy'],
    );
  });

  it('an unknown future version is surfaced, backed up, and never clobbered', async () => {
    const future = JSON.stringify({ records: [{ id: 'from-the-future' }], version: 99 });
    const io = createMemoryHistoryIo(future);
    boot(io);
    await waitFor(() => expect(api?.bootReady).toBe(true));
    await settle();
    expect(api!.state.historyError).toMatch(/Unsupported history file version: 99/);
    expect(api!.state.records).toEqual([]);

    act(() => api!.dispatch({ record: newRow, type: 'append-record' }));
    act(() => api!.dispatch({ settings: { ...api!.state.settings, transcriptRetention: 'off' }, type: 'hydrate-settings', onboardingComplete: true }));
    await settle();
    expect(io.snapshot()).toBe(future);
    expect(io.backups()).toEqual([future]);
  });

  it('corrupt dictionary is backed up before defaults may be written', async () => {
    const io = createMemoryDictionaryIo('{not json');
    const result = await createDictionaryStore(io).load();
    expect(result).toMatchObject({ ok: false, writeBlocked: false });
    expect(io.backups()).toEqual(['{not json']);
    const blocked = await createDictionaryStore({ read: io.read, write: io.write }).load();
    expect(blocked).toMatchObject({ ok: false, writeBlocked: true });
  });

  it('settings v2 from #24 loads (after a backup) instead of resetting to defaults', async () => {
    const v2 = JSON.stringify({
      onboardingComplete: true,
      settings: { ...initialSettings, cleanupEnabled: true, cleanupModelId: null, transcriptRetention: 'forever' },
      version: 2,
    });
    const io = createMemorySettingsIo(v2);
    const result = await createSettingsStore(io).load();
    expect(result.ok).toBe(true);
    expect(result.file.settings.transcriptRetention).toBe('forever');
    expect(io.backups()).toEqual([v2]);
  });

  it('settings from a future version are backed up and never replaced with defaults', async () => {
    const future = JSON.stringify({ settings: { transcriptRetention: 'forever' }, version: 99 });
    const io = createMemorySettingsIo(future);
    const result = await createSettingsStore(io).load();
    expect(result).toMatchObject({ ok: false, writeBlocked: true });
    expect(result.ok || result.error).toMatch(/Unsupported settings file version: 99/);
    expect(io.backups()).toEqual([future]);
  });

  it('dictionary from a future version is backed up and never replaced', async () => {
    const future = JSON.stringify({ version: 99, words: ['x'] });
    const io = createMemoryDictionaryIo(future);
    const result = await createDictionaryStore(io).load();
    expect(result).toMatchObject({ ok: false, writeBlocked: true });
    expect(io.backups()).toEqual([future]);
  });

  it('only truly corrupt settings JSON may be replaced, after a backup', async () => {
    const io = createMemorySettingsIo('{not json');
    const result = await createSettingsStore(io).load();
    expect(result).toMatchObject({ ok: false, writeBlocked: false });
    expect(io.backups()).toEqual(['{not json']);
  });

  it('app keeps future-version settings and dictionary files untouched', async () => {
    const futureSettings = JSON.stringify({ settings: {}, version: 99 });
    const futureDict = JSON.stringify({ version: 99, words: ['keep'] });
    const settingsIo = createMemorySettingsIo(futureSettings);
    const dictIo = createMemoryDictionaryIo(futureDict);
    api = null;
    render(
      <AppProvider
        clock={() => NOW}
        dictionaryPersistence={{ enabled: true, store: createDictionaryStore(dictIo) }}
        historyPersistence={{ enabled: true, store: createHistoryStore(createMemoryHistoryIo(null)) }}
        settingsPersistence={{ enabled: true, store: createSettingsStore(settingsIo) }}
      >
        <Probe />
      </AppProvider>,
    );
    await waitFor(() => expect(api?.bootReady).toBe(true));
    act(() => api!.dispatch({ settings: { ...api!.state.settings, transcriptRetention: 'forever' }, type: 'hydrate-settings', onboardingComplete: true }));
    act(() => api!.dispatch({ type: 'hydrate-words', words: ['changed'] }));
    await settle();
    expect(settingsIo.snapshot()).toBe(futureSettings);
    expect(dictIo.snapshot()).toBe(futureDict);
  });

  it('a file that stays unreadable is backed up once across launches', async () => {
    const io = createMemoryHistoryIo('{broken');
    await createHistoryStore(io).load('forever', NOW);
    await createHistoryStore(io).load('forever', NOW);
    expect(io.backups()).toEqual(['{broken']);
  });
});

