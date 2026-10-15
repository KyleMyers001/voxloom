/// #42 blocker: settings:changed must never echo back into the window that saved.
/// Models Tauri's any-target listen(): every listener gets every emit.
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppProvider, useApp } from '../../src/app/AppContext';
import { createInitialState } from '../../src/app/state';
import { mergeForeignSave } from '../../src/app/useSettingsSync';
import { listenSettingsChanged } from '../../src/services/settingsWindow';
import {
  createMemorySettingsIo, createSettingsStore, defaultSettingsFile, parseSettingsJson,
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
  getCurrentWebviewWindow: () => ({ label: 'main' }),
}));

function Probe() {
  const { dispatch, settings, state } = useApp();
  return (
    <>
      <output aria-label="style">{state.settings.style}</output>
      <output aria-label="appearance">{state.settings.appearance}</output>
      <output aria-label="nonfailed">{state.records.filter((r) => r.status !== 'failed').length}</output>
      <button onClick={() => settings.update({ key: 'style', value: 'casual' })} type="button">A</button>
      <button onClick={() => settings.update({ key: 'appearance', value: 'dark' })} type="button">B</button>
      <button
        onClick={() => dispatch({
          now: 1_000,
          record: { ...createInitialState(1_000).records[0], id: 'kept', status: 'inserted' },
          type: 'append-record',
        })}
        type="button"
      >
        Rec
      </button>
    </>
  );
}

describe('settings:changed echo', () => {
  it('A-then-B in one window: the echo of A neither reverts B nor rehydrates', async () => {
    const io = createMemorySettingsIo(serializeSettingsFile(defaultSettingsFile().settings, true));
    const writes: string[] = [];
    const realWrite = io.write.bind(io);
    // Model settings_save: write, then broadcast with the saver's label (echo included).
    io.write = async (contents: string) => {
      await realWrite(contents);
      writes.push(contents);
      setTimeout(() => bus.emit({ contents, source: 'main' }), 0);
    };
    render(
      <AppProvider settingsPersistence={{ enabled: true, store: createSettingsStore(io) }}>
        <Probe />
      </AppProvider>,
    );
    await waitFor(() => expect(bus.listeners.length).toBeGreaterThan(0));
    act(() => screen.getByText('A').click());
    act(() => screen.getByText('B').click());
    await waitFor(() => expect(writes.length).toBeGreaterThanOrEqual(1));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.getByLabelText('style')).toHaveTextContent('casual');
    expect(screen.getByLabelText('appearance')).toHaveTextContent('dark');
    const last = parseSettingsJson(writes.at(-1)!);
    expect(last.ok && last.file.settings).toMatchObject({ appearance: 'dark', style: 'casual' });
  });

  it('applies a save from the other window (source "settings")', async () => {
    const io = createMemorySettingsIo(serializeSettingsFile(defaultSettingsFile().settings, true));
    render(
      <AppProvider settingsPersistence={{ enabled: true, store: createSettingsStore(io) }}>
        <Probe />
      </AppProvider>,
    );
    await waitFor(() => expect(bus.listeners.length).toBeGreaterThan(0));
    const contents = serializeSettingsFile({ ...defaultSettingsFile().settings, style: 'very-casual' }, true);
    act(() => bus.emit({ contents, source: 'settings' }));
    await waitFor(() => expect(screen.getByLabelText('style')).toHaveTextContent('very-casual'));
  });
});

describe('retention Off from the Settings window (BUS-78)', () => {
  it('clears loaded transcripts in main, not only on restart', async () => {
    const io = createMemorySettingsIo(serializeSettingsFile(defaultSettingsFile().settings, true));
    render(
      <AppProvider settingsPersistence={{ enabled: true, store: createSettingsStore(io) }}>
        <Probe />
      </AppProvider>,
    );
    await waitFor(() => expect(bus.listeners.length).toBeGreaterThan(0));
    act(() => screen.getByText('Rec').click());
    expect(Number(screen.getByLabelText('nonfailed').textContent)).toBeGreaterThan(0);
    const contents = serializeSettingsFile(
      { ...defaultSettingsFile().settings, transcriptRetention: 'off' }, true,
    );
    act(() => bus.emit({ contents, source: 'settings' }));
    await waitFor(() => expect(screen.getByLabelText('nonfailed')).toHaveTextContent('0'));
  });
});

describe('listenSettingsChanged with an any-target listener', () => {
  it('drops the saving window\'s own event and passes the other window\'s', async () => {
    const handler = vi.fn();
    const unlisten = await listenSettingsChanged(handler);
    bus.emit({ contents: '{}', source: 'main' });
    expect(handler).not.toHaveBeenCalled();
    bus.emit({ contents: '{}', source: 'settings' });
    expect(handler).toHaveBeenCalledOnce();
    unlisten();
  });
});

describe('mergeForeignSave', () => {
  it('takes only keys the other window changed, keeping a local pending edit', () => {
    const base = defaultSettingsFile();
    const incoming = { ...base, settings: { ...base.settings, appearance: 'dark' as const } };
    const current = { onboardingComplete: true, settings: { ...base.settings, style: 'very-casual' as const } };
    const merged = mergeForeignSave(incoming, base, current);
    expect(merged.settings.appearance).toBe('dark');
    expect(merged.settings.style).toBe('very-casual');
  });
});
