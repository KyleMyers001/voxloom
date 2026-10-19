/// One cleanup model status per window (BUS-16 PR 2c). `cleanup_model_status`
/// hashes the whole 397 MB GGUF, so it is read once, on first use, and again
/// only on an explicit action (Check again). An import applies the status the
/// import itself returns. Remounting Home or switching tabs never re-reads it.
/// A #77-style native verified marker that makes the read cheap is a PR 3/4
/// target (BUS-16 comment 10486).

import type { CleanupModelStore } from '../../services/cleanup/contracts';
import { createTauriCleanupModelStore } from '../../services/cleanup/tauriAdapter';
import type { CleanupModelStatus } from '../../services/cleanup/types';
import type { CleanupModelView } from './cleanupCopy';

export interface CleanupModelSnapshot {
  /** Transient: checking, an error, or the latest status. */
  view: CleanupModelView;
  /** Last known `runtimeAvailable`; unknown counts as false. */
  workerAvailable: boolean;
  /** BUS-101: last import failure; cleared on Check again or the next import. */
  importError: string | null;
}

const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

function checkedStatus(status: CleanupModelStatus | undefined): CleanupModelStatus {
  // Native IPC result: check its shape before trusting it.
  if (typeof status?.available !== 'boolean' || typeof status.runtimeAvailable !== 'boolean'
    || typeof status.id !== 'string') {
    throw new Error('unexpected status from the app');
  }
  return status;
}

let snapshot: CleanupModelSnapshot = {
  view: { kind: 'checking' }, workerAvailable: false, importError: null,
};
let generation = 0;
let requested = false;
/** A status has been read or applied at least once in this window. */
let loaded = false;
/** Last verified status; kept across checking/error so import failure can restore it. */
let lastStatus: CleanupModelStatus | null = null;
/** BUS-106: one in-flight status read; overlapping Check again reuses it. */
let reading: Promise<void> | null = null;
let modelStore: CleanupModelStore | null = null;
const listeners = new Set<() => void>();

function publish(next: Partial<CleanupModelSnapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

/** Keep a known status on import failure; otherwise show an error view. */
function publishImportFailure(reason: unknown) {
  const text = message(reason);
  if (lastStatus) {
    publish({ view: { kind: 'status', status: lastStatus }, importError: text });
    return;
  }
  if (!loaded) requested = false;
  publish({ view: { kind: 'error', message: text }, importError: text });
}

export const cleanupModelCache = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  snapshot: (): CleanupModelSnapshot => snapshot,
  /** Test seam: the store to use; defaults to the native one. */
  useStore(store: CleanupModelStore | undefined) {
    if (store) modelStore = store;
  },
  store: (): CleanupModelStore => modelStore ??= createTauriCleanupModelStore(),
  /** First consumer in this window: read the status once. */
  ensureLoaded() {
    if (requested) return;
    requested = true;
    void cleanupModelCache.refresh();
  },
  /** Explicit re-read (Check again). Overlapping calls share one status(). */
  refresh(): Promise<void> {
    if (reading) return reading;
    requested = true;
    const request = ++generation;
    publish({ view: { kind: 'checking' }, importError: null });
    reading = (async () => {
      try {
        const status = checkedStatus(await cleanupModelCache.store().status());
        if (request !== generation) return;
        loaded = true;
        lastStatus = status;
        publish({
          view: { kind: 'status', status },
          workerAvailable: status.runtimeAvailable,
          importError: null,
        });
      } catch (reason: unknown) {
        if (request !== generation) return;
        // Nothing known yet: let the next consumer (e.g. reopening Capture) retry.
        if (!loaded) requested = false;
        publish({ view: { kind: 'error', message: message(reason) }, importError: null });
      } finally {
        reading = null;
      }
    })();
    return reading;
  },
  /** Clears the import-failure line (start of a new import attempt). */
  clearImportError() {
    if (snapshot.importError !== null) publish({ importError: null });
  },
  /** A status from somewhere else (the import result); supersedes pending reads. */
  apply(status: CleanupModelStatus) {
    generation++;
    try {
      const checked = checkedStatus(status);
      loaded = true;
      requested = true;
      lastStatus = checked;
      publish({
        view: { kind: 'status', status: checked },
        workerAvailable: checked.runtimeAvailable,
        importError: null,
      });
    } catch (reason: unknown) {
      publishImportFailure(reason);
    }
  },
  fail(reason: unknown) {
    generation++;
    publishImportFailure(reason);
  },
};

/** Tests only: forget the cached status and store. */
export function resetCleanupModelCacheForTests() {
  snapshot = { view: { kind: 'checking' }, workerAvailable: false, importError: null };
  generation++;
  requested = false;
  loaded = false;
  lastStatus = null;
  reading = null;
  modelStore = null;
  listeners.clear();
}

if (import.meta.env.MODE === 'test') {
  (globalThis as { __voxloomResetCleanupModelCache?: () => void })
    .__voxloomResetCleanupModelCache = resetCleanupModelCacheForTests;
}
