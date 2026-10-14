/// BUS-52: only one model download runs at a time from the Models tab.
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelsTab } from '../../src/features/settings/ModelsTab';
import { createMockSttModelStore } from '../../src/services/stt/mockStt';
import { SttError, type SttDownloadProgress } from '../../src/services/stt/types';
import { useSttModels } from '../../src/services/stt/useSttModels';
import { renderWithApp } from './testUtils';

const factory = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('../../src/services/stt/factory', async (importActual) => {
  const actual = await importActual<typeof import('../../src/services/stt/factory')>();
  return { ...actual, createSttModelStore: () => factory.store ?? actual.createSttModelStore() };
});

afterEach(() => { factory.store = null; });

type Gate = { resolve: () => void; reject: (err: unknown) => void };

/** Store whose downloads wait at a gate; `release()` lets the latest one finish, `fail()` rejects it. */
function gatedStore() {
  const store = createMockSttModelStore({ downloadSteps: 1 });
  const real = store.download.bind(store);
  const gates: Gate[] = [];
  let lastProgress: ((p: SttDownloadProgress) => void) | undefined;
  const download = vi.fn(async (id: string, onProgress?: (p: SttDownloadProgress) => void) => {
    lastProgress = onProgress;
    await new Promise<void>((resolve, reject) => { gates.push({ reject, resolve }); });
    return real(id, onProgress);
  });
  return Object.assign(store, {
    download,
    fail: () => gates.pop()?.reject(new SttError('download-failed', 'network error (HTTP 503)')),
    lastProgress: () => lastProgress,
    release: () => gates.pop()?.resolve(),
  });
}

const downloadButtons = () => screen.getAllByRole('button', { name: 'Download' });
const expectAllEnabled = () => waitFor(() => { for (const b of downloadButtons()) expect(b).toBeEnabled(); });

async function startFirstDownload(store: ReturnType<typeof gatedStore>) {
  factory.store = store;
  renderWithApp(<ModelsTab />);
  const buttons = await screen.findAllByRole('button', { name: 'Download' });
  expect(buttons.length).toBeGreaterThan(1);
  await userEvent.click(buttons[0]);
  await waitFor(() => { for (const b of downloadButtons()) expect(b).toBeDisabled(); });
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

  it('ignores progress that arrives after the download is no longer in flight', async () => {
    const store = gatedStore();
    const { result } = renderHook(() => useSttModels({ onSelect: vi.fn(), selectedModelId: 'whisper-tiny.en', store }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let first!: Promise<void>;
    act(() => { first = result.current.downloadModel('whisper-base.en'); });
    const late = store.lastProgress()!;
    await act(async () => { store.release(); await first; });
    expect(result.current.progress).toBeNull();
    act(() => { late({ bytesReceived: 1, bytesTotal: 2, modelId: 'whisper-base.en', ratio: .5 }); });
    expect(result.current.progress).toBeNull();
  });
});

describe('ModelsTab single download', () => {
  it('locks the other Download buttons until the download finishes', async () => {
    const store = gatedStore();
    await startFirstDownload(store);
    expect(screen.getAllByText('Available after the current download.').length).toBeGreaterThan(0);
    await act(async () => { store.release(); });
    await expectAllEnabled();
    expect(store.download).toHaveBeenCalledTimes(1);
  });

  it('re-enables the other Download buttons when the download fails', async () => {
    const store = gatedStore();
    await startFirstDownload(store);
    await act(async () => { store.fail(); });
    await expectAllEnabled();
    expect(await screen.findByRole('button', { name: 'Retry download' })).toBeEnabled();
  });

  it('re-enables the other Download buttons when the download is cancelled', async () => {
    const store = gatedStore();
    await startFirstDownload(store);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel download' }));
    await act(async () => { store.release(); });
    await expectAllEnabled();
    expect(screen.queryByRole('button', { name: 'Retry download' })).toBeNull();
  });

  it('locks Retry on a failed row while another model downloads', async () => {
    const store = gatedStore();
    await startFirstDownload(store);
    await act(async () => { store.fail(); });
    const retry = await screen.findByRole('button', { name: 'Retry download' });
    await userEvent.click(downloadButtons()[0]);
    await waitFor(() => expect(retry).toBeDisabled());
    // Locked Retry uses the same plain .btn disabled look as a locked Download.
    expect(retry).not.toHaveClass('primary');
    // Visual order matches spoken order: error first, then the lock reason.
    const [errorId, noteId] = retry.getAttribute('aria-describedby')!.split(' ');
    const error = document.getElementById(errorId)!;
    const note = document.getElementById(noteId)!;
    expect(error).toHaveClass('stt-model-error');
    expect(note).toHaveTextContent('Available after the current download.');
    expect(error.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => { store.release(); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry download' })).toBeEnabled());
    expect(store.download).toHaveBeenCalledTimes(2);
  });
});
