/**
 * BUS-86: after history.json was unreadable (failed Off save, then a failed
 * rollback reload), a later reload that reads it successfully makes memory
 * match disk again, so new records must be saved. A reload that still fails
 * must not re-enable writes.
 */
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppProvider, useApp } from '../../src/app/AppContext';
import { initialSettings } from '../../src/domain/fixtures';
import type { DictationRecord } from '../../src/domain/types';
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

vi.mock('@tauri-apps/api/core', async (importActual) => ({
  ...(await importActual<typeof import('@tauri-apps/api/core')>()),
  isTauri: () => true,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: 'main' }),
}));

function rec(id: string): DictationRecord {
  return {
    createdAt: 1_000,
    durationSeconds: 1,
    id,
    model: null,
    recoveryExpiresAt: null,
    status: 'inserted',
    style: 'formal',
    text: id,
  };
}

let api: ReturnType<typeof useApp> | null = null;
function Probe() {
  api = useApp();
  return null;
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const READ_FAILED = { ok: false as const, error: 'history.json read failed (I/O error)' };

type Inner = ReturnType<typeof createHistoryStore>;
type Load = (inner: Inner, args: Parameters<Inner['load']>) => ReturnType<Inner['load']>;

/**
 * Boots with history a, b. The first settings save (Off) fails, which starts
 * a reload; `loadBehavior` decides what that reload and later ones return.
 */
async function bootWithBlockedHistory() {
  const historyIo = createMemoryHistoryIo(serializeHistoryFile([rec('a'), rec('b')]));
  const inner = createHistoryStore(historyIo);
  const ctl: { load: Load } = { load: async () => READ_FAILED };
  let loads = 0;
  const save = vi.fn(inner.save);
  const historyStore = {
    ...inner,
    load: async (...args: Parameters<Inner['load']>) => {
      loads += 1;
      return loads === 1 ? inner.load(...args) : ctl.load(inner, args);
    },
    save,
  };
  const innerSettings = createSettingsStore(createMemorySettingsIo(
    serializeSettingsFile({ ...initialSettings, transcriptRetention: 'forever' }, true),
  ));
  let settingsSaves = 0;
  const settingsStore = {
    ...innerSettings,
    save: async (...args: Parameters<typeof innerSettings.save>) => {
      settingsSaves += 1;
      if (settingsSaves === 1) throw new Error('disk full');
      return innerSettings.save(...args);
    },
  };
  api = null;
  render(
    <AppProvider
      historyPersistence={{ enabled: true, store: historyStore }}
      settingsPersistence={{ enabled: true, store: settingsStore }}
    >
      <Probe />
    </AppProvider>,
  );
  await waitFor(() => expect(api?.bootReady).toBe(true));
  await settle();
  save.mockClear();
  const before = historyIo.snapshot();

  act(() => api!.settings.update({ key: 'transcriptRetention', value: 'off' }));
  await waitFor(() => expect(api!.state.settingsError).toMatch(/disk full/));
  await waitFor(() => expect(api!.state.historyError).toMatch(/read failed/));
  return { before, ctl, historyIo, save };
}

const idsOnDisk = (snapshot: string | null) =>
  (JSON.parse(snapshot!) as { records: { id: string }[] }).records.map((r) => r.id).sort();

describe('history writes after a later successful reload (BUS-86)', () => {
  it('an unrelated settings save reloads successfully, then a new record IS saved', async () => {
    const { ctl, historyIo, save } = await bootWithBlockedHistory();

    ctl.load = (inner, args) => inner.load(...args);
    act(() => api!.settings.update({ key: 'style', value: 'casual' } as never));
    await waitFor(() => expect(api!.state.historyError).toBeNull());
    await settle();
    save.mockClear();

    act(() => api!.dispatch({ now: Date.now(), record: rec('new'), type: 'append-record' }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    await settle();

    expect(idsOnDisk(historyIo.snapshot())).toEqual(['a', 'b', 'new']);
  });

  it('a reload that still fails keeps writes blocked after an unrelated save', async () => {
    const { before, historyIo, save } = await bootWithBlockedHistory();

    act(() => api!.settings.update({ key: 'style', value: 'casual' } as never));
    await settle();
    act(() => api!.dispatch({ now: Date.now(), record: rec('new'), type: 'append-record' }));
    await settle();

    expect(save).not.toHaveBeenCalled();
    expect(historyIo.snapshot()).toBe(before);
    expect(api!.state.historyError).toMatch(/read failed/);
  });
});
