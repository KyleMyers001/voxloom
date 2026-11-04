// BUS-181: one-click download in Settings > Cleanup model, next to Import.
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
    importModel: vi.fn().mockResolvedValue(null),
    status: vi.fn().mockResolvedValue(status),
  } satisfies CleanupModelStore;
  return { pending, store };
}

function Harness({ modelStore }: { modelStore: CleanupModelStore }) {
  return <CleanupSettings isNative model={useCleanupModel(true, modelStore)} />;
}

const downloadButton = () => screen.queryByRole('button', { name: 'Download (397 MB)' });
const importButton = () => screen.getByRole('button', { name: 'Import model…' });
const note = () => document.getElementById('settings-cleanup-model-note')?.textContent;

async function startDownload(store: CleanupModelStore) {
  const user = userEvent.setup();
  renderWithApp(<Harness modelStore={store} />);
  await waitFor(() => expect(downloadButton()).toBeInTheDocument());
  expect(note()).toBe('Not installed. Download it, or import the Qwen3 0.6B (Q4_K_M) GGUF file.');
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
    renderWithApp(<Harness modelStore={{ importModel: vi.fn(), status: vi.fn().mockResolvedValue(missing) }} />);
    await waitFor(() => expect(note()).toMatch(/^Not installed/));
    expect(downloadButton()).toBeNull();
    expect(importButton()).toBeInTheDocument();
  });

  it('shows progress and Cancel, blocks Import meanwhile, then applies the verified status', async () => {
    const { pending, store } = downloadingStore();
    const user = await startDownload(store);
    act(() => { pending[0].progress({ bytesReceived: 42, bytesTotal: 100, ratio: 0.42 }); });
    expect(screen.getByRole('button', { name: 'Downloading… 42%' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(importButton()).toHaveAttribute('aria-disabled', 'true');
    await user.click(importButton());
    expect(store.importModel).not.toHaveBeenCalled();
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
    expect(note()).toBe('Not installed. Download it, or import the Qwen3 0.6B (Q4_K_M) GGUF file. Download cancelled.');
    expect(importButton()).toHaveAttribute('aria-disabled', 'false');
    await user.click(downloadButton()!);
    expect(store.download).toHaveBeenCalledTimes(2);
    expect(note()).not.toMatch(/cancelled/);
  });

  it.each([
    [new CleanupDownloadError('checksum', 'x'), 'The downloaded file didn\'t match the expected checksum and was deleted. Try again.'],
    [new CleanupDownloadError('failed', 'request failed: offline'),
      'Couldn\'t download the model: request failed: offline. Check your connection and try again, or import the file.'],
  ])('a failure shows its line and leaves Import usable (%s)', async (error, line) => {
    const { pending, store } = downloadingStore();
    const user = await startDownload(store);
    await act(async () => { pending[0].reject(error); });
    expect(note()).toBe(`Not installed. Download it, or import the Qwen3 0.6B (Q4_K_M) GGUF file. ${line}`);
    await user.click(importButton());
    expect(store.importModel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(note()).not.toContain(line));
  });
});
