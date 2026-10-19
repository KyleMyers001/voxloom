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
// Written by main 7fd142b's own v1 writer (createDogfoodRecord +
// serializeHistoryFile), not a v2 file with its version flipped.
const V1 = readFileSync(join(__dirname, '../fixtures/history-v1.json'), 'utf8');
const V1_IDS = ['v1-inserted', 'v1-raw-differs', 'v1-unverified', 'v1-failed'];
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
  it('parses the v2 fixture, keeping rawText and cleanup provenance', () => {
    const parsed = parseHistoryJson(V2);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.sourceVersion).toBe(2);
    expect(parsed.file.records.map((r) => [r.id, r.rawText, r.text])).toEqual([
      ['v2-cleaned', 'um so the meeting is at three', 'The meeting is at three.'],
      ['v2-legacy', 'hello world', 'hello world'],
    ]);
    expect(parsed.file.records[0].cleanup).toMatchObject({ status: 'cleaned' });
  });

  it('store backs up a v1 file before reporting it migratable', async () => {
    const io = createMemoryHistoryIo(V1);
    const result = await createHistoryStore(io).load('forever', NOW);
    expect(result).toMatchObject({ migratedFrom: 1, ok: true });
    expect(io.backups()).toEqual([V1]);
    expect(io.snapshot()).toBe(V1);
  });

  it('store refuses to migrate a v1 file it cannot back up', async () => {
    const io = createMemoryHistoryIo(V1);
    const noBackup = { read: io.read, write: io.write };
    const result = await createHistoryStore(noBackup).load('forever', NOW);
    expect(result.ok).toBe(false);
  });

  it('app boots with v1 history, shows it, and only then rewrites it as v2', async () => {
    const io = createMemoryHistoryIo(V1);
    boot(io);
    await waitFor(() => expect(api?.bootReady).toBe(true));
    await settle();
    expect(api!.state.historyError).toBeNull();
    expect(api!.state.records.map((r) => r.id)).toEqual(V1_IDS);
    expect(io.backups()).toEqual([V1]);

    act(() => api!.dispatch({ record: newRow, type: 'append-record' }));
    await waitFor(() => expect(io.snapshot() ?? '').toContain('new-after-boot'));
    const disk = JSON.parse(io.snapshot()!) as { records: { id: string }[]; version: number };
    expect(disk.version).toBe(2);
    expect(disk.records.map((r) => r.id).sort()).toEqual(
      ['new-after-boot', ...V1_IDS].sort(),
    );
  });

  it('migrates main\'s real v1 rows as skipped legacy-v1, keeping their text', () => {
    const parsed = parseHistoryJson(V1);
    expect(parsed).toMatchObject({ ok: true, sourceVersion: 1 });
    if (!parsed.ok) return;
    const original = (JSON.parse(V1) as { records: DictationRecord[] }).records;
    expect(parsed.file.records.map((r) => r.id)).toEqual(V1_IDS);
    parsed.file.records.forEach((record, index) => {
      const source = original[index];
      expect(record.cleanup).toEqual({
        dictionaryDigest: null,
        dictionaryVersion: 1,
        modelDigest: null,
        modelId: null,
        promptVersion: 'legacy-v1',
        reason: 'migrated from history v1',
        status: 'skipped',
      });
      expect(record.text).toBe(source.text);
      // v1 stored rawText only when it differed (BUS-23); otherwise raw = final.
      expect(record.rawText).toBe(source.rawText ?? source.text);
      if (source.rawText === undefined) expect(record.rawText).toBe(record.text);
      expect(record.status).toBe(source.status);
    });
    expect(parsed.file.records[1].rawText).toBe('[Music] hello world');
    expect(parsed.file.records[2].mayHaveInserted).toEqual({ copied: true });
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

  it('current settings v2 loads without a migration backup', async () => {
    const v2 = JSON.stringify({
      onboardingComplete: true,
      settings: { ...initialSettings, cleanupEnabled: true, cleanupModelId: null, transcriptRetention: 'forever' },
      version: 2,
    });
    const io = createMemorySettingsIo(v2);
    const result = await createSettingsStore(io).load();
    expect(result.ok).toBe(true);
    expect(result.file.settings.transcriptRetention).toBe('forever');
    expect(io.backups()).toEqual([]);
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

  it('main rewrites a v1 settings file as v2 during boot (after backup)', async () => {
    const v2 = JSON.stringify({
      onboardingComplete: true,
      settings: { ...initialSettings, cleanupEnabled: true, transcriptRetention: 'forever' },
      version: 1,
    });
    const settingsIo = createMemorySettingsIo(v2);
    api = null;
    render(
      <AppProvider
        clock={() => NOW}
        historyPersistence={{ enabled: true, store: createHistoryStore(createMemoryHistoryIo(null)) }}
        settingsPersistence={{ enabled: true, store: createSettingsStore(settingsIo) }}
      >
        <Probe />
      </AppProvider>,
    );
    await waitFor(() => expect(api?.bootReady).toBe(true));
    const disk = JSON.parse(settingsIo.snapshot()!) as {
      settings: { transcriptRetention: string };
      version: number;
    };
    expect(disk.version).toBe(2);
    expect(disk.settings.transcriptRetention).toBe('forever');
    expect(settingsIo.backups()).toEqual([v2]);
    expect(api!.state.settingsError).toBeNull();
  });

  it('main replaces corrupt settings with v2 defaults during boot, after a backup', async () => {
    const settingsIo = createMemorySettingsIo('{not json');
    api = null;
    render(
      <AppProvider
        clock={() => NOW}
        historyPersistence={{ enabled: true, store: createHistoryStore(createMemoryHistoryIo(null)) }}
        settingsPersistence={{ enabled: true, store: createSettingsStore(settingsIo) }}
      >
        <Probe />
      </AppProvider>,
    );
    await waitFor(() => expect(api?.bootReady).toBe(true));
    expect(JSON.parse(settingsIo.snapshot()!)).toMatchObject({ version: 2 });
    expect(settingsIo.backups()).toEqual(['{not json']);
  });

  it('settings read error: writes allowed only when the raw bytes were backed up', async () => {
    const readFails = async () => { throw new Error('invalid utf-8'); };
    const backedUp = await createSettingsStore({
      backup: async () => 'settings.json.unreadable-1.bak',
      read: readFails,
      write: async () => {},
    }).load();
    expect(backedUp).toMatchObject({ ok: false, writeBlocked: false });
    const backupFails = await createSettingsStore({
      backup: async () => { throw new Error('read for backup failed'); },
      read: readFails,
      write: async () => {},
    }).load();
    expect(backupFails).toMatchObject({ ok: false, writeBlocked: true });
    const noBackup = await createSettingsStore({ read: readFails, write: async () => {} }).load();
    expect(noBackup).toMatchObject({ ok: false, writeBlocked: true });
  });

  it('dictionary read error: writes allowed only when the raw bytes were backed up', async () => {
    const readFails = async () => { throw new Error('invalid utf-8'); };
    const backedUp = await createDictionaryStore({
      backup: async () => 'dictionary.json.unreadable-1.bak',
      read: readFails,
      write: async () => {},
    }).load();
    expect(backedUp).toMatchObject({ ok: false, writeBlocked: false });
    const backupFails = await createDictionaryStore({
      backup: async () => { throw new Error('read for backup failed'); },
      read: readFails,
      write: async () => {},
    }).load();
    expect(backupFails).toMatchObject({ ok: false, writeBlocked: true });
  });

  it('app with an unreadable-but-backed-up settings file stays durable', async () => {
    const writes: string[] = [];
    const io = {
      backup: async () => 'settings.json.unreadable-1.bak',
      read: async (): Promise<string | null> => {
        if (writes.length === 0) throw new Error('invalid utf-8');
        return writes.at(-1)!;
      },
      write: async (c: string) => { writes.push(c); },
    };
    api = null;
    render(
      <AppProvider
        clock={() => NOW}
        historyPersistence={{ enabled: true, store: createHistoryStore(createMemoryHistoryIo(null)) }}
        settingsPersistence={{ enabled: true, store: createSettingsStore(io) }}
      >
        <Probe />
      </AppProvider>,
    );
    await waitFor(() => expect(api?.bootReady).toBe(true));
    expect(writes).toHaveLength(1);
    act(() => api!.dispatch({ key: 'style', type: 'set-setting', value: 'casual' }));
    await waitFor(() => expect(writes.at(-1)).toContain('"style": "casual"'));
  });

  it('keeps cleanup settings through boot and a later edit in app state', async () => {
    const v2 = JSON.stringify({
      onboardingComplete: true,
      settings: {
        ...initialSettings,
        cleanupEnabled: true,
        cleanupModelId: 'local-cleanup-small',
        style: 'casual',
      },
      version: 2,
    });
    const settingsIo = createMemorySettingsIo(v2);
    api = null;
    render(
      <AppProvider
        clock={() => NOW}
        historyPersistence={{ enabled: true, store: createHistoryStore(createMemoryHistoryIo(null)) }}
        settingsPersistence={{ enabled: true, store: createSettingsStore(settingsIo) }}
      >
        <Probe />
      </AppProvider>,
    );
    await waitFor(() => expect(api?.bootReady).toBe(true));
    type Disk = { settings: Record<string, unknown>; version: number };
    const afterBoot = JSON.parse(settingsIo.snapshot()!) as Disk;
    expect(afterBoot.version).toBe(2);
    expect(afterBoot.settings).toMatchObject({
      cleanupEnabled: true,
      cleanupModelId: 'local-cleanup-small',
      style: 'casual',
    });
    expect(api!.state.settings).toMatchObject({
      cleanupEnabled: true, cleanupModelId: 'local-cleanup-small',
    });

    act(() => api!.dispatch({ key: 'style', type: 'set-setting', value: 'formal' }));
    await waitFor(() => expect((JSON.parse(settingsIo.snapshot()!) as Disk).settings.style).toBe('formal'));
    expect((JSON.parse(settingsIo.snapshot()!) as Disk).settings).toMatchObject({
      cleanupEnabled: true,
      cleanupModelId: 'local-cleanup-small',
    });
  });

  it('known keys stay authoritative over raw values when extras are merged', async () => {
    const raw = JSON.stringify({
      onboardingComplete: true,
      settings: { ...initialSettings, cleanupEnabled: false, style: 'not-a-style' },
      version: 1,
    });
    const io = createMemorySettingsIo(raw);
    const store = createSettingsStore(io);
    const loaded = await store.load();
    await store.save(loaded.file.settings, true);
    const disk = JSON.parse(io.snapshot()!) as { settings: Record<string, unknown> };
    expect(disk.settings.style).toBe(initialSettings.style);
    expect(disk.settings.cleanupEnabled).toBe(false);
  });

  it('keeps an unknown __proto__ settings key as data', async () => {
    const raw = '{"onboardingComplete":true,"settings":{"__proto__":{"x":1},"style":"formal"},"version":1}';
    const io = createMemorySettingsIo(raw);
    const store = createSettingsStore(io);
    const loaded = await store.load();
    await store.save(loaded.file.settings, true);
    expect(io.snapshot()).toContain('"__proto__"');
    const disk = JSON.parse(io.snapshot()!) as { settings: Record<string, unknown> };
    expect(Object.getOwnPropertyDescriptor(disk.settings, '__proto__')?.value).toEqual({ x: 1 });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('reload drops unknown keys that are no longer on disk', async () => {
    const io = createMemorySettingsIo(JSON.stringify({
      onboardingComplete: true, settings: { ...initialSettings, futureOption: true }, version: 1,
    }));
    const store = createSettingsStore(io);
    await store.load();
    await io.write(JSON.stringify({ onboardingComplete: true, settings: initialSettings, version: 1 }));
    const loaded = await store.load();
    await store.save(loaded.file.settings, true);
    expect(io.snapshot()).not.toContain('futureOption');
  });

  describe('a backup that copied nothing (null path) never unlocks a write', () => {
    const nullBackup = async () => null;
    const readFails = async (): Promise<string | null> => { throw new Error('EISDIR'); };

    it('settings: read error, corrupt JSON and v1 rewrite all stay blocked', async () => {
      const write = async () => {};
      const readErr = await createSettingsStore({ backup: nullBackup, read: readFails, write }).load();
      expect(readErr).toMatchObject({ ok: false, writeBlocked: true });
      const corrupt = await createSettingsStore({ backup: nullBackup, read: async () => '{bad', write }).load();
      expect(corrupt).toMatchObject({ ok: false, writeBlocked: true });
      const v2 = JSON.stringify({ onboardingComplete: true, settings: initialSettings, version: 1 });
      const migrate = await createSettingsStore({ backup: nullBackup, read: async () => v2, write }).load();
      expect(migrate).toMatchObject({ ok: false, writeBlocked: true });
    });

    it('dictionary: read error and corrupt JSON stay blocked', async () => {
      const write = async () => {};
      const readErr = await createDictionaryStore({ backup: nullBackup, read: readFails, write }).load();
      expect(readErr).toMatchObject({ ok: false, writeBlocked: true });
      const corrupt = await createDictionaryStore({ backup: nullBackup, read: async () => '{bad', write }).load();
      expect(corrupt).toMatchObject({ ok: false, writeBlocked: true });
    });

    it('history: v1 is not migrated', async () => {
      const result = await createHistoryStore({
        backup: nullBackup, read: async () => V1, write: async () => {},
      }).load('forever', NOW);
      expect(result.ok).toBe(false);
    });

    it('app: settings with a null-path backup are never overwritten', async () => {
      const writes: string[] = [];
      api = null;
      render(
        <AppProvider
          clock={() => NOW}
          historyPersistence={{ enabled: true, store: createHistoryStore(createMemoryHistoryIo(null)) }}
          settingsPersistence={{
            enabled: true,
            store: createSettingsStore({
              backup: nullBackup, read: async () => '{bad', write: async (c) => { writes.push(c); },
            }),
          }}
        >
          <Probe />
        </AppProvider>,
      );
      await waitFor(() => expect(api?.bootReady).toBe(true));
      act(() => api!.dispatch({ key: 'style', type: 'set-setting', value: 'casual' }));
      await settle();
      expect(writes).toEqual([]);
    });
  });

  it('first launch (no files) writes without any backup', async () => {
    let backups = 0;
    const backup = async () => { backups += 1; return 'unexpected'; };
    const settingsWrites: string[] = [];
    const dictWrites: string[] = [];
    const histWrites: string[] = [];
    api = null;
    render(
      <AppProvider
        clock={() => NOW}
        dictionaryPersistence={{ enabled: true, store: createDictionaryStore({ backup, read: async () => null, write: async (c) => { dictWrites.push(c); } }) }}
        historyPersistence={{ enabled: true, store: createHistoryStore({ backup, read: async () => null, write: async (c) => { histWrites.push(c); } }) }}
        settingsPersistence={{ enabled: true, store: createSettingsStore({ backup, read: async () => null, write: async (c) => { settingsWrites.push(c); } }) }}
      >
        <Probe />
      </AppProvider>,
    );
    await waitFor(() => expect(api?.bootReady).toBe(true));
    act(() => api!.dispatch({ key: 'style', type: 'set-setting', value: 'casual' }));
    act(() => api!.dispatch({ record: newRow, type: 'append-record' }));
    act(() => api!.dispatch({ type: 'hydrate-words', words: ['voxloom'] }));
    await waitFor(() => expect(settingsWrites.at(-1)).toContain('"style": "casual"'));
    await waitFor(() => expect(histWrites.at(-1)).toContain('new-after-boot'));
    await waitFor(() => expect(dictWrites.at(-1)).toContain('voxloom'));
    expect(backups).toBe(0);
    expect(api!.state.settingsError).toBeNull();
  });

  it('reset notice names the saved original', async () => {
    const result = await createSettingsStore({
      backup: async () => '/data/settings.json.unreadable-1.bak',
      read: async () => '{bad',
      write: async () => {},
    }).load();
    expect(result.ok || result.error).toBe(
      'Settings couldn\'t be read and were reset to defaults. Your original file is saved at /data/settings.json.unreadable-1.bak.',
    );
  });
});

