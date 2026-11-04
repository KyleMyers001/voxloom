import { useSyncExternalStore } from 'react';
import type { CleanupModelStore } from '../../services/cleanup/contracts';
import { CleanupDownloadError } from '../../services/cleanup/modelDownload';
import type { CleanupModelStatus } from '../../services/cleanup/types';
import {
  CLEANUP_DOWNLOAD_CANCELLED, CLEANUP_DOWNLOAD_CHECKSUM, cleanupDownloadFailedNote,
} from './cleanupCopy';
import type { CleanupModel } from './useCleanupModel';

interface DownloadSnapshot {
  downloading: boolean;
  /** Last progress ratio, 0..1. */
  ratio: number;
  /** Outcome line after a failed or cancelled download; null otherwise. */
  note: string | null;
}

export interface CleanupDownload extends DownloadSnapshot {
  /** The store can download (the native one can; test fakes may not). */
  supported: boolean;
  start: () => Promise<void>;
  cancel: () => void;
}

export function downloadNote(reason: unknown): string {
  if (reason instanceof CleanupDownloadError) {
    if (reason.kind === 'cancelled') return CLEANUP_DOWNLOAD_CANCELLED;
    if (reason.kind === 'checksum') return CLEANUP_DOWNLOAD_CHECKSUM;
  }
  return cleanupDownloadFailedNote(reason instanceof Error ? reason.message : String(reason));
}

// Window-level, like cleanupModelCache: switching Settings tabs unmounts the
// row, but the native download keeps running, so its state must outlive it.
const IDLE: DownloadSnapshot = { downloading: false, note: null, ratio: 0 };
let snapshot = IDLE;
const listeners = new Set<() => void>();

function publish(next: Partial<DownloadSnapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

async function start(
  store: CleanupModelStore,
  apply: (status: CleanupModelStatus) => void,
  refresh: () => Promise<void>,
) {
  if (snapshot.downloading || !store.download) return;
  publish({ downloading: true, note: null, ratio: 0 });
  try {
    // The verified status comes back with the download: no second hash.
    apply(await store.download((progress) => { publish({ ratio: progress.ratio }); }));
    publish({ downloading: false });
  } catch (reason: unknown) {
    publish({ downloading: false, note: downloadNote(reason) });
    // A failure after the rename (permissions, directory sync) can leave a
    // verified model installed: re-read the status so it matches the disk.
    void refresh();
  }
}

/** Tests only: forget any download state. */
export function resetCleanupDownloadForTests() {
  snapshot = IDLE;
  listeners.clear();
}

if (import.meta.env.MODE === 'test') {
  (globalThis as { __voxloomResetCleanupDownload?: () => void })
    .__voxloomResetCleanupDownload = resetCleanupDownloadForTests;
}

/**
 * BUS-181: one-click download state for the Cleanup model row. A failure
 * leaves nothing on disk natively, so a retry starts clean.
 */
export function useCleanupDownload(model: Pick<CleanupModel, 'apply' | 'refresh' | 'store'>): CleanupDownload {
  const { apply, refresh, store } = model;
  const current = useSyncExternalStore(subscribe, () => snapshot);
  return {
    ...current,
    // The pending download rejects as cancelled; that sets the note.
    cancel: () => { void store().cancelDownload?.().catch(() => {}); },
    start: () => start(store(), apply, refresh),
    supported: typeof store().download === 'function',
  };
}
