/**
 * BUS-78: Retention Off with no in-memory stash.
 * Optimistic Off clears memory immediately but defers history.json wipe until
 * settings.json confirms Off. A failed local save reloads records from disk.
 */
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppProvider, useApp } from '../../src/app/AppContext';
import { initialSettings } from '../../src/domain/fixtures';
import type { DictationRecord, Settings } from '../../src/domain/types';
import {
  createHistoryStore,
  createMemoryHistoryIo,
  serializeHistoryFile,
} from '../../src/services/history';
import {
  createMemorySettingsIo,
  createSettingsStore,
  serializeSettingsFile,
} from '../../src/services/settings';

const bus = vi.hoisted(() => ({
  listeners: [] as ((e: { payload: unknown }) => void)[],
  emit(payload: unknown) {
    for (const l of [...this.listeners]) l({ payload });
  },
  reset() {
    this.listeners = [];
  },
}));

vi.mock('@tauri-apps/api/core', async (importActual) => ({
  ...(await importActual<typeof import('@tauri-apps/api/core')>()),
  isTauri: () => true,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (_event: string, handler: (e: { payload: unknown }) => void) => {
    bus.listeners.push(handler);
    return Promise.resolve(() => {
      bus.listeners = bus.listeners.filter((l) => l !== handler);
    });
  },
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: 'main' }),
}));

function rec(id: string, status: DictationRecord['status'], recovery: number | null = null): DictationRecord {
  return {
    createdAt: 1_000,
    durationSeconds: 1,
    id,
    model: null,
    recoveryExpiresAt: recovery,
    status,
    style: 'formal',
    text: id,
  };
}

let api: ReturnType<typeof useApp> | null = null;
function Probe() {
  api = useApp();
  return null;
}

function mounts(opts: {
  historyRecords: DictationRecord[];
  settings?: Settings;
  settingsSave?: (settings: Settings, complete: boolean) => Promise<void>;
}) {
  bus.reset();
  const settingsFile = serializeSettingsFile(
    opts.settings ?? { ...initialSettings, transcriptRetention: 'forever' },
    true,
  );
  const settingsIo = createMemorySettingsIo(settingsFile);
  const innerSettings = createSettingsStore(settingsIo);
  const settingsStore = {
    ...innerSettings,
    save: opts.settingsSave
      ?? ((settings: Settings, complete: boolean) => innerSettings.save(settings, complete)),
  };
  const historyIo = createMemoryHistoryIo(serializeHistoryFile(opts.historyRecords));
  const historyStore = createHistoryStore(historyIo);
  api = null;
  render(
    <AppProvider
      historyPersistence={{ enabled: true, store: historyStore }}
      settingsPersistence={{ enabled: true, store: settingsStore }}
    >
      <Probe />
    </AppProvider>,
  );
  return { historyIo, settingsIo };
}

describe('Retention Off: reload-from-disk on failed save (BUS-78)', () => {
  it('rolls Off back and restores transcripts from disk (not a stash)', async () => {
    const rows = [rec('a', 'inserted'), rec('b', 'failed', Date.now() + 60_000)];
    const save = vi.fn().mockRejectedValue(new Error('disk full'));
    const { historyIo } = mounts({ historyRecords: rows, settingsSave: save });
    await waitFor(() => expect(api?.bootReady).toBe(true));
    const before = historyIo.snapshot();
    expect(api!.state.records.map((r) => r.id).sort()).toEqual(['a', 'b']);

    act(() => api!.settings.update({ key: 'transcriptRetention', value: 'off' }));
    expect(api!.state.records.map((r) => r.id)).toEqual(['b']);
    // Wipe deferred: disk unchanged while Off is unconfirmed.
    expect(historyIo.snapshot()).toBe(before);

    await waitFor(() => expect(save).toHaveBeenCalled());
    await waitFor(() => expect(api!.state.settings.transcriptRetention).toBe('forever'));
    await waitFor(() => expect(api!.state.records.map((r) => r.id).sort()).toEqual(['a', 'b']));
    expect(api!.state.settingsError).toMatch(/disk full/);
    expect(historyIo.snapshot()).toBe(before);
  });

  it('confirmed Off wipe runs after settings save and stays cleared', async () => {
    const rows = [rec('a', 'inserted'), rec('b', 'failed', Date.now() + 60_000)];
    const { historyIo } = mounts({ historyRecords: rows });
    await waitFor(() => expect(api?.bootReady).toBe(true));

    act(() => api!.settings.update({ key: 'transcriptRetention', value: 'off' }));
    expect(api!.state.records.map((r) => r.id)).toEqual(['b']);
    await waitFor(() => expect(api!.state.settings.transcriptRetention).toBe('off'));
    await waitFor(() => {
      expect(JSON.parse(historyIo.snapshot()!).records).toEqual([]);
    });
    expect(api!.state.records.map((r) => r.id)).toEqual(['b']);
  });

  it('foreign confirmed Off clears memory and does not restore on a later forever hydrate', async () => {
    const rows = [rec('a', 'inserted'), rec('b', 'failed', Date.now() + 60_000)];
    const { historyIo } = mounts({ historyRecords: rows });
    await waitFor(() => expect(api?.bootReady).toBe(true));
    await waitFor(() => expect(bus.listeners.length).toBeGreaterThan(0));

    const offFile = serializeSettingsFile({ ...initialSettings, transcriptRetention: 'off' }, true);
    act(() => bus.emit({ contents: offFile, source: 'settings' }));
    await waitFor(() => expect(api!.state.settings.transcriptRetention).toBe('off'));
    expect(api!.state.records.map((r) => r.id)).toEqual(['b']);
    await waitFor(() => expect(JSON.parse(historyIo.snapshot()!).records).toEqual([]));

    const foreverFile = serializeSettingsFile({ ...initialSettings, transcriptRetention: 'forever' }, true);
    act(() => bus.emit({ contents: foreverFile, source: 'settings' }));
    await waitFor(() => expect(api!.state.settings.transcriptRetention).toBe('forever'));
    // Cleared transcripts (a) must not return; recoverable (b) may stay in memory.
    expect(api!.state.records.map((r) => r.id)).toEqual(['b']);
    await waitFor(() => {
      const ids = JSON.parse(historyIo.snapshot()!).records.map((r: DictationRecord) => r.id);
      expect(ids).toEqual(['b']);
    });
  });

  it('delete-record while Off is pending stays deleted after a failed save reload', async () => {
    const rows = [rec('a', 'inserted'), rec('b', 'failed', Date.now() + 60_000)];
    let release!: (err?: Error) => void;
    const gate = new Promise<void>((resolve, reject) => {
      release = (err) => (err ? reject(err) : resolve());
    });
    const { historyIo } = mounts({
      historyRecords: rows,
      settingsSave: () => gate,
    });
    await waitFor(() => expect(api?.bootReady).toBe(true));

    act(() => api!.settings.update({ key: 'transcriptRetention', value: 'off' }));
    expect(api!.state.records.map((r) => r.id)).toEqual(['b']);

    await act(async () => {
      api!.history.delete('b');
    });
    expect(api!.state.records).toEqual([]);
    await waitFor(() => {
      expect(JSON.parse(historyIo.snapshot()!).records.map((r: DictationRecord) => r.id)).toEqual(['a']);
    });

    await act(async () => {
      release(new Error('disk full'));
      await gate.catch(() => {});
    });
    await waitFor(() => expect(api!.state.settings.transcriptRetention).toBe('forever'));
    await waitFor(() => expect(api!.state.records.map((r) => r.id)).toEqual(['a']));
    expect(JSON.parse(historyIo.snapshot()!).records.map((r: DictationRecord) => r.id)).toEqual(['a']);
  });
});
