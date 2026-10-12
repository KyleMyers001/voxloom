/// UI PR 7: Models tab cards, Retry download, list-error Try again.
import { act, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ModelsTab } from '../../src/features/settings/ModelsTab';
import { createMockSttModelStore } from '../../src/services/stt/mockStt';
import { SttError } from '../../src/services/stt/types';
import { useSttModels } from '../../src/services/stt/useSttModels';
import { renderWithApp } from './testUtils';

const factory = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('../../src/services/stt/factory', async (importActual) => {
  const actual = await importActual<typeof import('../../src/services/stt/factory')>();
  return { ...actual, createSttModelStore: () => factory.store ?? actual.createSttModelStore() };
});

/** Mock store whose first download of `failId` fails with an HTTP 503. */
function flakyStore(failId = 'whisper-base.en') {
  const store = createMockSttModelStore({ downloadSteps: 1 });
  const real = store.download.bind(store);
  let failed = false;
  const download = vi.fn(async (id: string, onProgress?: Parameters<typeof real>[1]) => {
    if (id === failId && !failed) {
      failed = true;
      throw new SttError('download-failed', 'network error (HTTP 503)');
    }
    return real(id, onProgress);
  });
  return Object.assign(store, { download });
}

describe('useSttModels retry', () => {
  it('records a per-model failure and clears it when Retry starts', async () => {
    const store = flakyStore();
    const { result } = renderHook(() => useSttModels({ onSelect: vi.fn(), selectedModelId: 'whisper-tiny.en', store }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.downloadModel('whisper-base.en').catch(() => {}); });
    expect(result.current.failures['whisper-base.en']).toBe('Download failed: network error (HTTP 503). Nothing was saved.');
    await act(async () => { await result.current.downloadModel('whisper-base.en'); });
    expect(result.current.failures['whisper-base.en']).toBeUndefined();
    expect(store.download).toHaveBeenCalledTimes(2);
  });

  it('does not record a failure for a cancel', async () => {
    const store = createMockSttModelStore();
    vi.spyOn(store, 'download').mockRejectedValueOnce(new SttError('cancelled', 'Download cancelled'));
    const { result } = renderHook(() => useSttModels({ onSelect: vi.fn(), selectedModelId: 'whisper-tiny.en', store }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.downloadModel('whisper-tiny.en').catch(() => {}); });
    expect(result.current.failures).toEqual({});
  });

  it('reload() is the list-error Try again', async () => {
    const store = createMockSttModelStore();
    vi.spyOn(store, 'list').mockRejectedValueOnce(new Error('ipc down'));
    const { result } = renderHook(() => useSttModels({ onSelect: vi.fn(), selectedModelId: 'whisper-tiny.en', store }));
    await waitFor(() => expect(result.current.listError).toBe('ipc down'));
    await act(async () => { await result.current.reload(); });
    expect(result.current.listError).toBeNull();
    expect(result.current.models.length).toBeGreaterThan(0);
  });
});

describe('Models tab', () => {
  it('shows the failed card with its error and a Retry that restarts the download', async () => {
    const store = flakyStore();
    factory.store = store;
    const user = userEvent.setup();
    renderWithApp(<ModelsTab />);
    expect(store.download).not.toHaveBeenCalled(); // nothing downloads without a click
    const row = (await screen.findByText('whisper-base.en')).closest('li')!;
    expect(within(row).getByText('148 MB', { exact: false })).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Download' }));
    const retry = await within(row).findByRole('button', { name: 'Retry download' });
    expect(within(row).getByRole('alert')).toHaveTextContent('Download failed: network error (HTTP 503). Nothing was saved.');
    expect(retry).toHaveAccessibleDescription(/Nothing was saved/);
    expect(within(row).getByText('failed')).toBeInTheDocument();
    await user.click(retry);
    expect(await within(row).findByText('On disk')).toBeInTheDocument();
    expect(within(row).queryByRole('alert')).toBeNull();
    expect(store.download).toHaveBeenCalledTimes(2);
    factory.store = null;
  });

  it('offers Try again when the model list fails, and the catalog-empty state', async () => {
    const store = createMockSttModelStore();
    const list = vi.spyOn(store, 'list').mockRejectedValueOnce(new Error('ipc down'));
    factory.store = store;
    const user = userEvent.setup();
    renderWithApp(<ModelsTab />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load the model list.');
    expect(screen.queryByText('No models in catalog.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('whisper-tiny.en')).toBeInTheDocument();
    list.mockResolvedValueOnce([]);
    factory.store = null;
  });

  it('shows a determinate progress bar with bytes while downloading', async () => {
    const store = createMockSttModelStore();
    let release: () => void = () => {};
    vi.spyOn(store, 'download').mockImplementation(async (id, onProgress) => {
      onProgress?.({ bytesReceived: 33_000_000, bytesTotal: 78_000_000, modelId: id, ratio: 0.42 });
      await new Promise<void>((r) => { release = r; });
    });
    factory.store = store;
    const user = userEvent.setup();
    renderWithApp(<ModelsTab />);
    const row = (await screen.findByText('whisper-tiny.en')).closest('li')!;
    await user.click(within(row).getByRole('button', { name: 'Download' }));
    const bar = await within(row).findByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(within(row).getByText('42% · 33 of 78 MB')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Cancel download' })).toBeInTheDocument();
    await act(async () => release());
    factory.store = null;
  });
});
