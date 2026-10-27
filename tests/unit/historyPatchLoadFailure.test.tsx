/**
 * BUS-86 / CONTRIBUTING store rule 4: while a Retention Off save is pending,
 * Delete patches history.json on disk. If that patch can't read the file, no
 * later write (including the confirmed Off wipe) may overwrite it.
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

describe('history patch load failure during a pending Off (BUS-86)', () => {
  it('a confirmed Off never overwrites a history.json the delete patch could not read', async () => {
    const historyIo = createMemoryHistoryIo(serializeHistoryFile([rec('a'), rec('b')]));
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
    const innerSettings = createSettingsStore(createMemorySettingsIo(
      serializeSettingsFile({ ...initialSettings, transcriptRetention: 'forever' }, true),
    ));
    // The first settings save (the Off) stays pending until released.
    let releaseOff: () => void = () => {};
    const offHeld = new Promise<void>((resolve) => { releaseOff = resolve; });
    let settingsSaves = 0;
    const settingsStore = {
      ...innerSettings,
      save: async (...args: Parameters<typeof innerSettings.save>) => {
        settingsSaves += 1;
        if (settingsSaves === 1) await offHeld;
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
    await waitFor(() => expect(api!.state.settings.transcriptRetention).toBe('off'));
    act(() => api!.history.delete('a'));
    await waitFor(() => expect(api!.state.historyError).toMatch(/read failed/));

    releaseOff();
    await settle();

    expect(save).not.toHaveBeenCalled();
    expect(historyIo.snapshot()).toBe(before);
    expect(api!.state.historyError).toMatch(/read failed/);
  });
});
