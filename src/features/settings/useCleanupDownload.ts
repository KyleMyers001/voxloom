import { useState } from 'react';
import { CleanupDownloadError } from '../../services/cleanup/modelDownload';
import {
  CLEANUP_DOWNLOAD_CANCELLED, CLEANUP_DOWNLOAD_CHECKSUM, cleanupDownloadFailedNote,
} from './cleanupCopy';
import type { CleanupModel } from './useCleanupModel';

export interface CleanupDownload {
  /** The store can download (the native one can; test fakes may not). */
  supported: boolean;
  downloading: boolean;
  /** Last progress ratio, 0..1. */
  ratio: number;
  /** Outcome line after a failed or cancelled download; null otherwise. */
  note: string | null;
  start: () => Promise<void>;
  cancel: () => void;
  clearNote: () => void;
}

export function downloadNote(reason: unknown): string {
  if (reason instanceof CleanupDownloadError) {
    if (reason.kind === 'cancelled') return CLEANUP_DOWNLOAD_CANCELLED;
    if (reason.kind === 'checksum') return CLEANUP_DOWNLOAD_CHECKSUM;
  }
  return cleanupDownloadFailedNote(reason instanceof Error ? reason.message : String(reason));
}

/**
 * BUS-181: one-click download state for the Cleanup model row. A success
 * applies the verified status the download returns (no second hash). A
 * failure leaves nothing on disk natively, so Import and a retry both work.
 */
export function useCleanupDownload(model: Pick<CleanupModel, 'apply' | 'clearImportError' | 'store'>): CleanupDownload {
  const { apply, clearImportError, store } = model;
  const [downloading, setDownloading] = useState(false);
  const [ratio, setRatio] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  const start = async () => {
    const native = store();
    if (downloading || !native.download) return;
    clearImportError();
    setNote(null);
    setRatio(0);
    setDownloading(true);
    try {
      apply(await native.download((progress) => { setRatio(progress.ratio); }));
    } catch (reason: unknown) {
      setNote(downloadNote(reason));
    } finally {
      setDownloading(false);
    }
  };

  const cancel = () => {
    // The pending download rejects as cancelled; that sets the note.
    void store().cancelDownload?.().catch(() => {});
  };

  return {
    cancel, clearNote: () => { setNote(null); }, downloading, note, ratio, start,
    supported: typeof store().download === 'function',
  };
}
