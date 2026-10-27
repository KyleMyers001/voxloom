/**
 * BUS-86 / CONTRIBUTING store rule 4: history that can't be read is never
 * written. A failed Retention Off save reloads history.json; if that reload
 * fails too, no later record or Off may write over the unreadable file.
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

/** Boots with history `a`; the first Off save fails and every reload load fails. */
async function bootWithFailingReload() {
  const historyIo = createMemoryHistoryIo(serializeHistoryFile([rec('a')]));
  const inner = createHistoryStore(historyIo);
  let loads = 0;
  const save = vi.fn(inner.save);
  const historyStore = {
    ...inner,
    load: async (...args: Parameters<typeof inner.load>) => {
      loads += 1;
      if (loads === 1) return inner.load(...args);
      return { ok: false as const, error: 'history.json read failed (I/O error)' };
    },
    save,
  };
  const settingsIo = createMemorySettingsIo(
    serializeSettingsFile({ ...initialSettings, transcriptRetention: 'forever' }, true),
  );
  const innerSettings = createSettingsStore(settingsIo);
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
  // Boot may rewrite the file once (cleanup metadata migration); only count
  // writes made after the failure sequence starts.
  await settle();
  save.mockClear();
  const before = historyIo.snapshot();

  act(() => api!.settings.update({ key: 'transcriptRetention', value: 'off' }));
  await waitFor(() => expect(api!.state.settingsError).toMatch(/disk full/));
  await waitFor(() => expect(api!.state.settings.transcriptRetention).toBe('forever'));
  await waitFor(() => expect(api!.state.historyError).toMatch(/read failed/));
  return { before, historyIo, save };
}

describe('history reload failure after a failed Off save (BUS-86)', () => {
  it('a record, a retried Off, then another record never write history.json', async () => {
    const { before, historyIo, save } = await bootWithFailingReload();

    act(() => api!.dispatch({ now: Date.now(), record: rec('r1'), type: 'append-record' }));
    await settle();
    expect(save).not.toHaveBeenCalled();

    act(() => api!.settings.update({ key: 'transcriptRetention', value: 'off' }));
    await waitFor(() => expect(api!.state.settings.transcriptRetention).toBe('off'));
    act(() => api!.dispatch({ now: Date.now(), record: rec('r2'), type: 'append-record' }));
    await settle();

    expect(save).not.toHaveBeenCalled();
    expect(historyIo.snapshot()).toBe(before);
  });

  it('retrying Off after the failed reload never writes history.json', async () => {
    const { before, historyIo, save } = await bootWithFailingReload();

    act(() => api!.settings.update({ key: 'transcriptRetention', value: 'off' }));
    await waitFor(() => expect(api!.state.settings.transcriptRetention).toBe('off'));
    await settle();

    expect(save).not.toHaveBeenCalled();
    expect(historyIo.snapshot()).toBe(before);
  });
});
