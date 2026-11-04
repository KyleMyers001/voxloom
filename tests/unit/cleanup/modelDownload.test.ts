// BUS-181: the native download adapter subscribes before invoking, unsubscribes
// afterwards, and maps native error codes to download failure kinds.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, listen, unlisten, handlers } = vi.hoisted(() => {
  const handlers: ((event: { payload: unknown }) => void)[] = [];
  const unlisten = vi.fn();
  return {
    handlers,
    invoke: vi.fn(),
    listen: vi.fn(async (_event: string, handler: (event: { payload: unknown }) => void) => {
      handlers.push(handler);
      return unlisten;
    }),
    unlisten,
  };
});
vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));

import {
  CLEANUP_DOWNLOAD_PROGRESS_EVENT, CleanupDownloadError, cancelCleanupDownload, downloadCleanupModel,
} from '../../../src/services/cleanup/modelDownload';
import { createTauriCleanupModelStore } from '../../../src/services/cleanup/tauriAdapter';

const status = { available: true, id: 'qwen3-0.6b-q4-k-m', runtimeAvailable: true, sha256: 'x' };

beforeEach(() => {
  handlers.length = 0;
  invoke.mockReset();
  listen.mockClear();
  unlisten.mockClear();
});

describe('downloadCleanupModel', () => {
  it('listens before invoking, forwards progress, and resolves with the status', async () => {
    const seen: number[] = [];
    invoke.mockImplementation(async () => {
      expect(listen).toHaveBeenCalledWith(CLEANUP_DOWNLOAD_PROGRESS_EVENT, expect.any(Function));
      handlers[0]({ payload: { bytesReceived: 1, bytesTotal: 2, ratio: 0.5 } });
      return status;
    });
    await expect(downloadCleanupModel((p) => seen.push(p.ratio))).resolves.toEqual(status);
    expect(invoke).toHaveBeenCalledWith('cleanup_download_model');
    expect(seen).toEqual([0.5]);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['cancelled', 'cancelled'],
    ['checksum-mismatch', 'checksum'],
    ['runtime-error', 'failed'],
    ['something-new', 'failed'],
  ])('maps native code %s to %s and still unsubscribes', async (code, kind) => {
    invoke.mockRejectedValue({ code, message: 'why' });
    const error = await downloadCleanupModel(() => {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CleanupDownloadError);
    expect(error).toMatchObject({ kind, message: 'why' });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('cancel invokes the native cancel and reports whether one was running', async () => {
    invoke.mockResolvedValue(true);
    await expect(cancelCleanupDownload()).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('cleanup_cancel_download');
  });

  it('the native model store offers download and cancel', () => {
    const store = createTauriCleanupModelStore();
    expect(store.download).toBe(downloadCleanupModel);
    expect(store.cancelDownload).toBe(cancelCleanupDownload);
  });
});
