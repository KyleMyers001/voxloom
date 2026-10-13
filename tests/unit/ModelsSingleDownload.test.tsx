/// BUS-52: only one model download runs at a time from the Models tab.
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ModelsTab } from '../../src/features/settings/ModelsTab';
import { createMockSttModelStore } from '../../src/services/stt/mockStt';
import { useSttModels } from '../../src/services/stt/useSttModels';
import { renderWithApp } from './testUtils';

const factory = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('../../src/services/stt/factory', async (importActual) => {
  const actual = await importActual<typeof import('../../src/services/stt/factory')>();
  return { ...actual, createSttModelStore: () => factory.store ?? actual.createSttModelStore() };
});

/** Store whose downloads hang until released. */
function gatedStore() {
  const store = createMockSttModelStore({ downloadSteps: 1 });
  const real = store.download.bind(store);
  let release: (() => void) | null = null;
  const download = vi.fn(async (id: string, onProgress?: Parameters<typeof real>[1]) => {
    await new Promise<void>((resolve) => { release = resolve; });
    return real(id, onProgress);
  });
  return Object.assign(store, { download, release: () => release?.() });
}

describe('useSttModels single download', () => {
  it('rejects a second download while one is running', async () => {
    const store = gatedStore();
    const { result } = renderHook(() => useSttModels({ onSelect: vi.fn(), selectedModelId: 'whisper-tiny.en', store }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let first!: Promise<void>;
    act(() => { first = result.current.downloadModel('whisper-base.en'); });
    await expect(result.current.downloadModel('whisper-small.en')).rejects.toThrow(/Another model is downloading/);
    await act(async () => { store.release(); await first; });
    expect(store.download).toHaveBeenCalledTimes(1);
  });
});

describe('ModelsTab single download', () => {
  it('disables the other Download buttons until the download finishes', async () => {
    const store = gatedStore();
    factory.store = store;
    renderWithApp(<ModelsTab />);
    const buttons = await screen.findAllByRole('button', { name: 'Download' });
    expect(buttons.length).toBeGreaterThan(1);
    await userEvent.click(buttons[0]);
    await waitFor(() => {
      const rest = screen.getAllByRole('button', { name: 'Download' });
      for (const b of rest) expect(b).toBeDisabled();
    });
    expect(screen.getAllByText('Available when the current download finishes').length).toBeGreaterThan(0);
    await act(async () => { store.release(); });
    await waitFor(() => {
      for (const b of screen.getAllByRole('button', { name: 'Download' })) expect(b).toBeEnabled();
    });
    expect(store.download).toHaveBeenCalledTimes(1);
    factory.store = null;
  });
});
