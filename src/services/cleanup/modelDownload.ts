/** BUS-181: one-click download of the pinned cleanup model (native side in
 * `cleanup/model_store/download.rs`). Completion is the invoke resolving with
 * the verified status, never a progress ratio alone. */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { CleanupModelStatus } from './types';

export const CLEANUP_DOWNLOAD_PROGRESS_EVENT = 'cleanup:download-progress';

export interface CleanupDownloadProgress {
  bytesReceived: number;
  bytesTotal: number;
  /** 0..1; reaches 1 only once the file is verified and installed. */
  ratio: number;
}

export type CleanupDownloadFailure = 'cancelled' | 'checksum' | 'failed';

export class CleanupDownloadError extends Error {
  constructor(readonly kind: CleanupDownloadFailure, message: string) {
    super(message);
    this.name = 'CleanupDownloadError';
  }
}

function downloadError(error: unknown): CleanupDownloadError {
  const native = error as { code?: unknown; message?: unknown } | null;
  const message = typeof native?.message === 'string' ? native.message : String(error);
  if (native?.code === 'cancelled') return new CleanupDownloadError('cancelled', message);
  if (native?.code === 'checksum-mismatch') return new CleanupDownloadError('checksum', message);
  return new CleanupDownloadError('failed', message);
}

export async function downloadCleanupModel(
  onProgress?: (progress: CleanupDownloadProgress) => void,
): Promise<CleanupModelStatus> {
  let unlisten: UnlistenFn | undefined;
  try {
    // Subscribe before invoke so early progress events are not missed.
    if (onProgress) {
      unlisten = await listen<CleanupDownloadProgress>(
        CLEANUP_DOWNLOAD_PROGRESS_EVENT, (event) => { onProgress(event.payload); },
      );
    }
    return await invoke<CleanupModelStatus>('cleanup_download_model');
  } catch (error: unknown) {
    throw downloadError(error);
  } finally {
    unlisten?.();
  }
}

/** Resolves false when no download was running. */
export async function cancelCleanupDownload(): Promise<boolean> {
  try {
    return await invoke<boolean>('cleanup_cancel_download');
  } catch (error: unknown) {
    throw downloadError(error);
  }
}
