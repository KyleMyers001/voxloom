// BUS-42 (#49 review): the Settings window may not back up settings.json
// (store_backup is main-only). A v2 file opened there must load calmly,
// write-blocked, and become writable once main broadcasts the v1 rewrite.
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppProvider, useApp } from '../../src/app/AppContext';
import { initialSettings } from '../../src/domain/fixtures';
import {
  SETTINGS_UPGRADING_MESSAGE,
  createMemorySettingsIo,
  createSettingsStore,
  parseSettingsJson,
  serializeSettingsFile,
} from '../../src/services/settings';

const bus = vi.hoisted(() => ({
  listeners: [] as ((e: { payload: unknown }) => void)[],
  emit(payload: unknown) { for (const l of [...this.listeners]) l({ payload }); },
}));

vi.mock('@tauri-apps/api/core', async (importActual) => ({
  ...(await importActual<typeof import('@tauri-apps/api/core')>()),
  isTauri: () => true,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (_event: string, handler: (e: { payload: unknown }) => void) => {
    bus.listeners.push(handler);
    return Promise.resolve(() => { bus.listeners = bus.listeners.filter((l) => l !== handler); });
  },
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: 'settings' }),
}));

let api: ReturnType<typeof useApp> | null = null;
function Probe() {
  api = useApp();
  return (
    <button onClick={() => api!.settings.update({ key: 'style', value: 'casual' })} type="button">
      edit
    </button>
  );
}

const V2 = JSON.stringify({
  onboardingComplete: true,
  settings: { ...initialSettings, cleanupEnabled: true, transcriptRetention: 'forever' },
  version: 2,
});

describe('Settings window with a v2 settings.json', () => {
  it('loads calmly, never writes, and re-enables writes on main\'s settings:changed', async () => {
    const mem = createMemorySettingsIo(V2);
    const writes: string[] = [];
    // Settings-window IO: read/write only, no backup (store_backup is main-only).
    const io = {
      read: mem.read,
      write: async (c: string) => { writes.push(c); await mem.write(c); },
    };
    render(
      <AppProvider settingsPersistence={{ enabled: true, store: createSettingsStore(io) }}>
        <Probe />
      </AppProvider>,
    );
    await waitFor(() => expect(api?.bootReady).toBe(true));
    await waitFor(() => expect(bus.listeners.length).toBeGreaterThan(0));
    expect(api!.state.settingsError).toBe(SETTINGS_UPGRADING_MESSAGE);
    expect(api!.state.settingsError).not.toMatch(/backup failed/i);
    // Values from the v2 file are shown even though writes are blocked.
    expect(api!.state.settings.transcriptRetention).toBe('forever');

    act(() => screen.getByText('edit').click());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(writes).toEqual([]);
    expect(mem.snapshot()).toBe(V2);

    // Main rewrote the file as v1 and broadcast it.
    const v1 = serializeSettingsFile({ ...initialSettings, transcriptRetention: 'forever' }, true);
    act(() => bus.emit({ contents: v1, source: 'main' }));
    await waitFor(() => expect(api!.state.settingsError).toBeNull());

    act(() => api!.settings.update({ key: 'appearance', value: 'dark' }));
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    const last = parseSettingsJson(writes.at(-1)!);
    expect(last.ok && last.file.version).toBe(1);
    expect(last.ok && last.file.settings).toMatchObject({ appearance: 'dark', transcriptRetention: 'forever' });
  });

  it('a future-version file keeps its real error in the Settings window', async () => {
    const future = JSON.stringify({ settings: {}, version: 99 });
    const mem = createMemorySettingsIo(future);
    const result = await createSettingsStore({ read: mem.read, write: mem.write }).load();
    expect(result).toMatchObject({ ok: false, writeBlocked: true });
    expect(result.ok || result.error).toMatch(/Unsupported settings file version: 99/);
  });
});
