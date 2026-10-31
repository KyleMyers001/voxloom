// BUS-45: a dictation that finishes before history hydrate completes at boot
// must not be dropped. It is queued, shown, and appended once hydrate lands;
// when history is read-only (BUS-42 gating) it is shown but never written.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppProvider, useApp } from '../../src/app/AppContext';
import { mergePreHydrateRecords } from '../../src/app/preHydrateRecords';
import { initialSettings } from '../../src/domain/fixtures';
import type { DictationRecord } from '../../src/domain/types';
import {
  createHistoryStore,
  createMemoryHistoryIo,
  serializeHistoryFile,
  type HistoryStore,
} from '../../src/services/history';
import {
  createMemorySettingsIo,
  createSettingsStore,
  serializeSettingsFile,
} from '../../src/services/settings';

const V2 = readFileSync(join(__dirname, '../fixtures/history-v2.json'), 'utf8');
const NOW = 1_800_000_000_000;

const early: DictationRecord = {
  createdAt: NOW - 5,
  durationSeconds: 1,
  id: 'before-hydrate',
  model: 'whisper-tiny.en',
  recoveryExpiresAt: null,
  status: 'inserted',
  style: 'formal',
  text: 'said before history loaded',
};

let api: ReturnType<typeof useApp> | null = null;
function Probe() {
  api = useApp();
  return null;
}

function gatedStore(store: HistoryStore) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gated: HistoryStore = {
    ...store,
    load: async (retention, now) => {
      await gate;
      return store.load(retention, now);
    },
  };
  return { release, store: gated };
}

function boot(
  store: HistoryStore,
  settingsIo = createMemorySettingsIo(serializeSettingsFile(initialSettings, true)),
) {
  api = null;
  return render(
    <AppProvider
      clock={() => NOW}
      historyPersistence={{ enabled: true, store }}
      settingsPersistence={{
        enabled: true,
        store: createSettingsStore(settingsIo),
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

describe('BUS-45 dictations made before history hydrate', () => {
  it('merges queued rows ahead of loaded rows', () => {
    const loaded = { ...early, id: 'loaded' };
    expect(mergePreHydrateRecords([loaded], [early]).map((r) => r.id))
      .toEqual(['before-hydrate', 'loaded']);
    expect(mergePreHydrateRecords([loaded], [])).toEqual([loaded]);
  });

  it('keeps and saves a dictation dispatched before hydrate', async () => {
    const io = createMemoryHistoryIo(V2);
    const gated = gatedStore(createHistoryStore(io));
    boot(gated.store);
    await settle();
    expect(api!.bootReady).toBe(false);

    act(() => api!.dispatch({ now: NOW, record: early, type: 'append-record' }));
    await settle();
    // Nothing writes before the load (and its backup) finishes.
    expect(io.snapshot()).toBe(V2);
    expect(io.backups()).toEqual([]);

    await act(async () => gated.release());
    await waitFor(() => expect(api?.bootReady).toBe(true));
    expect(api!.state.records.map((r) => r.id)).toEqual(
      ['before-hydrate', 'v2-cleaned', 'v2-legacy'],
    );
    expect(io.backups()).toEqual([]);
    await waitFor(() => expect(io.snapshot() ?? '').toContain('before-hydrate'));
    const disk = JSON.parse(io.snapshot()!) as { records: { id: string }[] };
    expect(disk.records.map((r) => r.id).sort()).toEqual(
      ['before-hydrate', 'v2-cleaned', 'v2-legacy'],
    );
  });

  it('shows but never writes a pre-hydrate dictation when history is blocked', async () => {
    const future = JSON.stringify({ records: [], version: 99 });
    const io = createMemoryHistoryIo(future);
    const gated = gatedStore(createHistoryStore(io));
    boot(gated.store);
    await settle();

    act(() => api!.dispatch({ now: NOW, record: early, type: 'append-record' }));
    await act(async () => gated.release());
    await waitFor(() => expect(api?.bootReady).toBe(true));
    await settle();

    expect(api!.state.records.map((r) => r.id)).toEqual(['before-hydrate']);
    expect(api!.state.historyError).not.toBeNull();
    expect(io.snapshot()).toBe(future);
  });

  it('shows but never writes a pre-hydrate dictation when settings block history', async () => {
    const io = createMemoryHistoryIo(V2);
    const gated = gatedStore(createHistoryStore(io));
    const corrupt = createMemorySettingsIo('{not json');
    // No backup capability: settings stay blocked, so history is read-only.
    boot(gated.store, { read: corrupt.read, write: corrupt.write } as typeof corrupt);
    await settle();

    act(() => api!.dispatch({ now: NOW, record: early, type: 'append-record' }));
    await act(async () => gated.release());
    await waitFor(() => expect(api?.bootReady).toBe(true));
    await settle();

    expect(api!.state.records.map((r) => r.id)).toEqual(
      ['before-hydrate', 'v2-cleaned', 'v2-legacy'],
    );
    expect(api!.state.historyError).toMatch(/read-only/);
    expect(io.snapshot()).toBe(V2);
  });

  it('marks history hydrated after booting with an unreadable history file', async () => {
    const io = createMemoryHistoryIo('{not json');
    boot(createHistoryStore(io));
    await waitFor(() => expect(api?.bootReady).toBe(true));
    await settle();
    expect(api!.state.historyHydrated).toBe(true);
    expect(api!.state.historyError).not.toBeNull();
  });

  it('backs up history after a settings reset, keeps early rows, prunes 400-day rows', async () => {
    // Unreadable settings are backed up and reset to defaults (30-day
    // retention), which forces a history backup before the first prune.
    const DAY = 24 * 60 * 60 * 1000;
    const old = { ...early, createdAt: NOW - 400 * DAY, id: 'old-400d' };
    const recent = { ...early, createdAt: NOW - DAY, id: 'recent-1d' };
    const original = serializeHistoryFile([recent, old]);
    const io = createMemoryHistoryIo(original);
    const gated = gatedStore(createHistoryStore(io));
    const settingsIo = createMemorySettingsIo('{not json');
    expect(initialSettings.transcriptRetention).toBe('30-days');
    boot(gated.store, settingsIo);
    await settle();

    const early2 = { ...early, id: 'before-hydrate-2' };
    // A stale queued row only the save-time prune can drop.
    const staleEarly = { ...early, createdAt: NOW - 400 * DAY, id: 'stale-early' };
    act(() => api!.dispatch({ now: NOW, record: staleEarly, type: 'append-record' }));
    act(() => api!.dispatch({ now: NOW, record: early, type: 'append-record' }));
    act(() => api!.dispatch({ now: NOW, record: early2, type: 'append-record' }));
    await settle();
    expect(io.snapshot()).toBe(original);
    expect(io.backups()).toEqual([]);

    await act(async () => gated.release());
    await waitFor(() => expect(api?.bootReady).toBe(true));
    expect(settingsIo.backups()).toEqual(['{not json']);
    // Backup holds the original byte for byte, taken before any write.
    expect(io.backups()).toEqual([original]);
    expect(api!.state.historyError).toBeNull();

    await waitFor(() => expect(io.snapshot() ?? '').toContain('before-hydrate-2'));
    const disk = JSON.parse(io.snapshot()!) as { records: { id: string }[] };
    expect(disk.records.map((r) => r.id).sort()).toEqual(
      ['before-hydrate', 'before-hydrate-2', 'recent-1d'],
    );
  });
});
