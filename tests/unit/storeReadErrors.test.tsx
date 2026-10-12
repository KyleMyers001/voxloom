// BUS-42 QA check 4 / check 1: a directory at a store path or an unreadable
// folder now surfaces from Rust as a read error (never "first launch"), and
// an invalid-UTF-8 dictionary.json is backed up once, then reset.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppProvider, useApp } from '../../src/app/AppContext';
import {
  createDictionaryStore,
  createMemoryDictionaryIo,
  type DictionaryFileIo,
} from '../../src/services/dictionary';
import { createHistoryStore, createMemoryHistoryIo, serializeHistoryFile } from '../../src/services/history';
import { createMemorySettingsIo, createSettingsStore, type SettingsFileIo } from '../../src/services/settings';

const V2 = readFileSync(join(__dirname, '../fixtures/history-v2.json'), 'utf8');
const NOW = 1_800_000_000_000;

/** Rust `read_store` error for a directory / EACCES: nothing to back up. */
function failingIo(message: string): SettingsFileIo & { writes: string[] } {
  const writes: string[] = [];
  return {
    backup: async () => null,
    read: async () => { throw new Error(message); },
    write: async (c) => { writes.push(c); },
    writes,
  };
}

let api: ReturnType<typeof useApp> | null = null;
function Probe() {
  api = useApp();
  return null;
}

async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

describe('store read errors (BUS-42)', () => {
  for (const msg of ['read settings.json: not a regular file', 'stat settings.json: Permission denied (os error 13)']) {
    it(`settings "${msg}" blocks writes and v2 history migration`, async () => {
      const settingsIo = failingIo(msg);
      const historyIo = createMemoryHistoryIo(V2);
      api = null;
      render(
        <AppProvider
          clock={() => NOW}
          historyPersistence={{ enabled: true, store: createHistoryStore(historyIo) }}
          settingsPersistence={{ enabled: true, store: createSettingsStore(settingsIo) }}
        >
          <Probe />
        </AppProvider>,
      );
      await waitFor(() => expect(api?.bootReady).toBe(true));
      await settle();
      expect(api!.state.settingsError).toMatch(/no file was backed up/);
      expect(api!.state.historyError).toMatch(/read-only until settings/);
      expect(api!.state.records.length).toBeGreaterThan(0);
      act(() => api!.dispatch({
        settings: { ...api!.state.settings, transcriptRetention: 'off' },
        onboardingComplete: true,
        type: 'hydrate-settings',
      }));
      await settle();
      expect(settingsIo.writes).toEqual([]);
      expect(historyIo.snapshot()).toBe(V2);
    });
  }

  it('v1 history + settings read error with no backup: history is never written', async () => {
    const settingsIo = failingIo('read settings.json: not a regular file');
    const row = {
      createdAt: NOW - 400 * 24 * 60 * 60 * 1000,
      durationSeconds: 1,
      id: 'old-forever',
      model: null,
      recoveryExpiresAt: null,
      status: 'copied' as const,
      style: 'formal' as const,
      text: 'keep',
    };
    const v1 = serializeHistoryFile([row]);
    const historyIo = createMemoryHistoryIo(v1);
    api = null;
    render(
      <AppProvider
        clock={() => NOW}
        historyPersistence={{ enabled: true, store: createHistoryStore(historyIo) }}
        settingsPersistence={{ enabled: true, store: createSettingsStore(settingsIo) }}
      >
        <Probe />
      </AppProvider>,
    );
    await waitFor(() => expect(api?.bootReady).toBe(true));
    await settle();
    expect(api!.state.historyError).toMatch(/read-only until settings/);
    act(() => api!.dispatch({ record: { ...row, createdAt: NOW, id: 'new' }, type: 'append-record' }));
    await settle();
    expect(historyIo.snapshot()).toBe(v1);
    expect(settingsIo.writes).toEqual([]);
    // Writes are still blocked, so the notice survives a new dictation.
    expect(api!.state.historyError).toMatch(/read-only until settings/);
  });

  it('settings reset: history.json is backed up byte-identical before any prune', async () => {
    // Corrupt settings with a working backup → reset to defaults (30-day).
    const settingsIo = createMemorySettingsIo('{corrupt');
    const row = {
      createdAt: NOW - 400 * 24 * 60 * 60 * 1000,
      durationSeconds: 1,
      id: 'old-forever',
      model: null,
      recoveryExpiresAt: null,
      status: 'copied' as const,
      style: 'formal' as const,
      text: 'keep',
    };
    const v1 = serializeHistoryFile([row]);
    const historyIo = createMemoryHistoryIo(v1);
    const writes: string[] = [];
    const watched = {
      ...historyIo,
      write: async (c: string) => {
        // The backup must already exist when the first prune lands.
        expect(historyIo.backups()).toEqual([v1]);
        writes.push(c);
        await historyIo.write(c);
      },
    };
    api = null;
    render(
      <AppProvider
        clock={() => NOW}
        historyPersistence={{ enabled: true, store: createHistoryStore(watched) }}
        settingsPersistence={{ enabled: true, store: createSettingsStore(settingsIo) }}
      >
        <Probe />
      </AppProvider>,
    );
    await waitFor(() => expect(api?.bootReady).toBe(true));
    await settle();
    expect(api!.state.settingsError).toMatch(/reset to defaults/);
    expect(api!.state.settings.transcriptRetention).not.toBe('forever');
    expect(historyIo.backups()).toEqual([v1]);
    act(() => api!.dispatch({ record: { ...row, createdAt: NOW, id: 'new' }, type: 'append-record' }));
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    expect(historyIo.backups()).toEqual([v1]);
  });

  it('settings reset but history backup fails: history stays read-only', async () => {
    const v1 = serializeHistoryFile([]);
    const writes: string[] = [];
    const io = {
      backup: async () => { throw new Error('disk full'); },
      read: async () => v1,
      write: async (c: string) => { writes.push(c); },
    };
    api = null;
    render(
      <AppProvider
        clock={() => NOW}
        historyPersistence={{ enabled: true, store: createHistoryStore(io) }}
        settingsPersistence={{ enabled: true, store: createSettingsStore(createMemorySettingsIo('{corrupt')) }}
      >
        <Probe />
      </AppProvider>,
    );
    await waitFor(() => expect(api?.bootReady).toBe(true));
    await settle();
    expect(api!.state.historyError).toMatch(/read-only/);
    act(() => api!.dispatch({
      record: { createdAt: NOW, durationSeconds: 1, id: 'n', model: null, recoveryExpiresAt: null, status: 'copied', style: 'formal', text: 'x' },
      type: 'append-record',
    }));
    await settle();
    expect(writes).toEqual([]);
  });

  for (const msg of [
    'read history.json: not a regular file',
    'stat history.json: Permission denied (os error 13)',
    'stat history.json: No such file or directory (broken symlink)',
  ]) {
    it(`history "${msg}": backup attempted, message matches, notice stays, no writes`, async () => {
      const writes: string[] = [];
      let backups = 0;
      const io = {
        backup: async () => { backups += 1; return null; },
        read: async () => { throw new Error(msg); },
        write: async (c: string) => { writes.push(c); },
      };
      api = null;
      render(
        <AppProvider clock={() => NOW} historyPersistence={{ enabled: true, store: createHistoryStore(io) }}>
          <Probe />
        </AppProvider>,
      );
      await waitFor(() => expect(api?.bootReady).toBe(true));
      await settle();
      const expected = `Failed to read history store: ${msg} (backup failed: no file was backed up; file left untouched)`;
      expect(api!.state.historyError).toBe(expected);
      expect(backups).toBe(1);
      act(() => api!.dispatch({
        record: { createdAt: NOW, durationSeconds: 1, id: 'n', model: null, recoveryExpiresAt: null, status: 'copied', style: 'formal', text: 'x' },
        type: 'append-record',
      }));
      await settle();
      expect(api!.state.historyError).toBe(expected);
      expect(writes).toEqual([]);
    });
  }

  it('dictionary read error without a backup stays blocked', async () => {
    const io: DictionaryFileIo = {
      backup: async () => null,
      read: async () => { throw new Error('read dictionary.json: not a regular file'); },
      write: async () => { throw new Error('must not write'); },
    };
    const result = await createDictionaryStore(io).load();
    expect(result).toMatchObject({ ok: false, writeBlocked: true });
    if (!result.ok) expect(result.error).toMatch(/no file was backed up/);
  });

  it('invalid UTF-8 dictionary: one backup, reset notice, valid empty v1 file', async () => {
    const mem = createMemoryDictionaryIo('\uFFFD-bytes');
    let first = true;
    const io: DictionaryFileIo = {
      ...mem,
      read: async () => {
        if (first) { first = false; throw new Error('read dictionary.json: stream did not contain valid UTF-8'); }
        return mem.read();
      },
    };
    const boot = () => {
      api = null;
      return render(
        <AppProvider clock={() => NOW} dictionaryPersistence={{ enabled: true, store: createDictionaryStore(io) }}>
          <Probe />
        </AppProvider>,
      );
    };
    const view = boot();
    await waitFor(() => expect(api?.bootReady).toBe(true));
    await settle();
    expect(api!.state.dictionaryError).toMatch(/reset to empty\. Your original file is saved at memory-backup-1/);
    const disk = JSON.parse(mem.snapshot()!) as { version: number; words: string[] };
    expect(disk).toMatchObject({ version: 1, words: [] });
    expect(mem.backups()).toHaveLength(1);
    view.unmount();

    boot();
    await waitFor(() => expect(api?.bootReady).toBe(true));
    await settle();
    expect(api!.state.dictionaryError).toBeNull();
    expect(mem.backups()).toHaveLength(1);
  });
});
