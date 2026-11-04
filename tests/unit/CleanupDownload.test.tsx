// BUS-181: one-click download in Settings > Cleanup model (BUS-186: the only install path).
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CleanupSettings } from '../../src/features/settings/CleanupSettings';
import { resetCleanupModelCacheForTests } from '../../src/features/settings/cleanupModelCache';
import { useCleanupModel } from '../../src/features/settings/useCleanupModel';
import type { CleanupModelStore } from '../../src/services/cleanup/contracts';
import { CleanupDownloadError, type CleanupDownloadProgress } from '../../src/services/cleanup/modelDownload';
import { CLEANUP_MODEL_ID, CLEANUP_MODEL_SHA256, type CleanupModelStatus } from '../../src/services/cleanup/types';
import { renderWithApp } from './testUtils';

const ready: CleanupModelStatus = {
  available: true, id: CLEANUP_MODEL_ID, runtimeAvailable: true, sha256: CLEANUP_MODEL_SHA256,
};
const missing: CleanupModelStatus = { ...ready, available: false };

interface Pending {
  progress: (p: CleanupDownloadProgress) => void;
  resolve: (s: CleanupModelStatus) => void;
  reject: (e: unknown) => void;
}

function downloadingStore(status: CleanupModelStatus = missing) {
  const pending: Pending[] = [];
  const store = {
    cancelDownload: vi.fn().mockResolvedValue(true),
    download: vi.fn((onProgress?: (p: CleanupDownloadProgress) => void) =>
      new Promise<CleanupModelStatus>((resolve, reject) => {
        pending.push({ progress: (p) => onProgress?.(p), reject, resolve });
      })),
    
    status: vi.fn().mockResolvedValue(status),
  } satisfies CleanupModelStore;
  return { pending, store };
}

function Harness({ modelStore }: { modelStore: CleanupModelStore }) {
  return <CleanupSettings isNative model={useCleanupModel(true, modelStore)} />;
}

const downloadButton = () => screen.queryByRole('button', { name: 'Download (397 MB)' });
const note = () => document.getElementById('settings-cleanup-model-note')?.textContent;

async function startDownload(store: CleanupModelStore) {
  const user = userEvent.setup();
  renderWithApp(<Harness modelStore={store} />);
  await waitFor(() => expect(downloadButton()).toBeInTheDocument());
  expect(note()).toBe('Not installed. Download it to use local cleanup.');
  await user.click(downloadButton()!);
  return user;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('Cleanup model download', () => {
  it('is offered only when the model is missing and the store can download', async () => {
    const installed = renderWithApp(<Harness modelStore={downloadingStore(ready).store} />);
    await waitFor(() => expect(note()).toBe('Qwen3 0.6B is installed.'));
    expect(downloadButton()).toBeNull();
    installed.unmount();
    resetCleanupModelCacheForTests();
    renderWithApp(<Harness modelStore={{ status: vi.fn().mockResolvedValue(missing) }} />);
    await waitFor(() => expect(note()).toMatch(/^Not installed/));
    expect(downloadButton()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import model…' })).toBeNull();
  });

  it('shows progress and Cancel, blocks Check again meanwhile, then applies the verified status', async () => {
    const { pending, store } = downloadingStore();
    const user = await startDownload(store);
    act(() => { pending[0].progress({ bytesReceived: 42, bytesTotal: 100, ratio: 0.42 }); });
    expect(screen.getByRole('button', { name: 'Downloading… 42%' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    const check = screen.getByRole('button', { name: 'Check again' });
    expect(check).toHaveAttribute('aria-disabled', 'true');
    await user.click(check);
    expect(store.status).toHaveBeenCalledTimes(1);
    await act(async () => { pending[0].resolve(ready); });
    expect(note()).toBe('Qwen3 0.6B is installed.');
    expect(downloadButton()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(store.status).toHaveBeenCalledTimes(1);
  });

  it('Cancel stops the download, says so, and Download can be retried', async () => {
    const { pending, store } = downloadingStore();
    const user = await startDownload(store);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(store.cancelDownload).toHaveBeenCalledTimes(1);
    await act(async () => { pending[0].reject(new CleanupDownloadError('cancelled', 'download cancelled')); });
    expect(note()).toBe('Not installed. Download it to use local cleanup. Download cancelled.');
    expect(screen.getByRole('button', { name: 'Check again' })).toHaveAttribute('aria-disabled', 'false');
    await user.click(downloadButton()!);
    expect(store.download).toHaveBeenCalledTimes(2);
    expect(note()).not.toMatch(/cancelled/);
  });

  it.each([
    [new CleanupDownloadError('checksum', 'x'), 'The downloaded file didn\'t match the expected checksum and was deleted. Try again.'],
    [new CleanupDownloadError('failed', 'request failed: offline'),
      'Couldn\'t download the model: request failed: offline. Check your connection and try again.'],
  ])('a failure shows its line and Download can be retried (%s)', async (error, line) => {
    const { pending, store } = downloadingStore();
    const user = await startDownload(store);
    await act(async () => { pending[0].reject(error); });
    expect(note()).toBe(`Not installed. Download it to use local cleanup. ${line}`);
    await user.click(downloadButton()!);
    expect(store.download).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(note()).not.toContain(line));
  });

  it('keeps progress and Cancel when the row unmounts and remounts (tab switch)', async () => {
    const { pending, store } = downloadingStore();
    const user = userEvent.setup();
    const first = renderWithApp(<Harness modelStore={store} />);
    await waitFor(() => expect(downloadButton()).toBeInTheDocument());
    await user.click(downloadButton()!);
    act(() => { pending[0].progress({ bytesReceived: 3, bytesTotal: 10, ratio: 0.3 }); });
    first.unmount();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    renderWithApp(<Harness modelStore={store} />);
    expect(screen.getByRole('button', { name: 'Downloading… 30%' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Check again' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(store.cancelDownload).toHaveBeenCalledTimes(1);
    await act(async () => { pending[0].resolve(ready); });
    expect(note()).toBe('Qwen3 0.6B is installed.');
    expect(store.download).toHaveBeenCalledTimes(1);
  });

  it('re-reads the status after a failure, so a model installed before the error shows', async () => {
    const { pending, store } = downloadingStore();
    await startDownload(store);
    store.status.mockResolvedValue(ready);
    await act(async () => { pending[0].reject(new CleanupDownloadError('failed', 'sync cleanup model directory: EIO')); });
    await waitFor(() => expect(note()).toMatch(/^Qwen3 0\.6B is installed\. Couldn't download the model: sync cleanup model directory: EIO\./));
    expect(store.status).toHaveBeenCalledTimes(2);
    expect(downloadButton()).toBeNull();
  });
});
