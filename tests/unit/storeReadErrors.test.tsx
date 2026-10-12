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
import { createHistoryStore, createMemoryHistoryIo } from '../../src/services/history';
import { createSettingsStore, type SettingsFileIo } from '../../src/services/settings';

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
