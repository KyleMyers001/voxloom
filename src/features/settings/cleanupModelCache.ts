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
}

const message = (reason: unknown): string => {
  // Adapter always wraps native {code, message} in CleanupEngineError.
  if (reason instanceof Error) return reason.message;
  return String(reason);
};

function checkedStatus(status: CleanupModelStatus | undefined): CleanupModelStatus {
  // Native IPC result: check its shape before trusting it.
  if (typeof status?.available !== 'boolean' || typeof status.runtimeAvailable !== 'boolean'
    || typeof status.id !== 'string') {
    throw new Error('unexpected status from the app');
  }
  return status;
}

let snapshot: CleanupModelSnapshot = { view: { kind: 'checking' }, workerAvailable: false };
let generation = 0;
let requested = false;
/** A status has been read or applied at least once in this window. */
let loaded = false;
let modelStore: CleanupModelStore | null = null;
const listeners = new Set<() => void>();

function publish(next: Partial<CleanupModelSnapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
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
  /** Explicit re-read (Check again). Only the latest request may publish. */
  async refresh() {
    requested = true;
    const request = ++generation;
    publish({ view: { kind: 'checking' } });
    try {
      const status = checkedStatus(await cleanupModelCache.store().status());
      if (request === generation) {
        loaded = true;
        publish({ view: { kind: 'status', status }, workerAvailable: status.runtimeAvailable });
      }
    } catch (reason: unknown) {
      if (request !== generation) return;
      // Nothing known yet: let the next consumer (e.g. reopening Capture) retry.
      if (!loaded) requested = false;
      publish({ view: { kind: 'error', message: message(reason) } });
    }
  },
  /** A status from somewhere else (the import result); supersedes pending reads. */
  apply(status: CleanupModelStatus) {
    generation++;
    try {
      const checked = checkedStatus(status);
      loaded = true;
      requested = true;
      publish({ view: { kind: 'status', status: checked }, workerAvailable: checked.runtimeAvailable });
    } catch (reason: unknown) {
      if (!loaded) requested = false;
      publish({ view: { kind: 'error', message: message(reason) } });
    }
  },
  fail(reason: unknown) {
    generation++;
    if (!loaded) requested = false;
    publish({ view: { kind: 'error', message: message(reason) } });
  },
};

/** Tests only: forget the cached status and store. */
export function resetCleanupModelCacheForTests() {
  snapshot = { view: { kind: 'checking' }, workerAvailable: false };
  generation++;
  requested = false;
  loaded = false;
  modelStore = null;
  listeners.clear();
}

if (import.meta.env.MODE === 'test') {
  (globalThis as { __voxloomResetCleanupModelCache?: () => void })
    .__voxloomResetCleanupModelCache = resetCleanupModelCacheForTests;
}
