/// #42 review: A→B→A while B's save is in flight must still write the final A.
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppProvider, useApp } from '../../src/app/AppContext';
import { initialSettings } from '../../src/domain/fixtures';
import type { Settings } from '../../src/domain/types';
import { createMemorySettingsIo, createSettingsStore, serializeSettingsFile } from '../../src/services/settings';

function deferredStore(initial: Settings) {
  const io = createMemorySettingsIo(serializeSettingsFile(initial, true));
  const inner = createSettingsStore(io);
  const pending: { release: () => void; style: string }[] = [];
  const written: string[] = [];
  const store = {
    ...inner,
    save: (settings: Settings, complete: boolean) => new Promise<void>((resolve) => {
      pending.push({
        release: () => { void inner.save(settings, complete).then(() => { written.push(settings.style); resolve(); }); },
        style: settings.style,
      });
    }),
  };
  return { io, pending, store, written };
}

let api: ReturnType<typeof useApp> | null = null;
function Probe() { api = useApp(); return null; }

describe('settings persistence ordering', () => {
  it('A→B→A with the B save in flight still saves the final A', async () => {
    const { io, pending, store, written } = deferredStore({ ...initialSettings, style: 'formal' });
    render(
      <AppProvider settingsPersistence={{ enabled: true, store }}>
        <Probe />
      </AppProvider>,
    );
    await waitFor(() => expect(api?.bootReady).toBe(true));
    act(() => api!.settings.update({ key: 'style', value: 'casual' })); // B, in flight
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => api!.settings.update({ key: 'style', value: 'formal' })); // back to A
    // Saves are serialized: release B, then the final A must be requested and written.
    await act(async () => { pending[0].release(); });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1].style).toBe('formal');
    await act(async () => { pending[1].release(); });
    await waitFor(() => expect(written).toEqual(['casual', 'formal']));
    expect(JSON.parse(io.snapshot()!).settings.style).toBe('formal');
  });
});
