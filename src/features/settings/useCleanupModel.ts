import { useEffect, useSyncExternalStore } from 'react';
import type { CleanupModelStore } from '../../services/cleanup/contracts';
import type { CleanupModelStatus } from '../../services/cleanup/types';
import type { CleanupModelView } from './cleanupCopy';
import { cleanupModelCache } from './cleanupModelCache';

export interface CleanupModel {
  /** Transient: checking, an error, or the latest status. */
  view: CleanupModelView;
  /**
   * Last known `runtimeAvailable`. Unknown (never read) counts as false. A
   * later check or error keeps the last known value, so Check again or an
   * import error never hide the block mid-use.
   */
  workerAvailable: boolean;
  /** BUS-101: import-failure line; null when none. */
  importError: string | null;
  /** Re-reads `cleanup_model_status`. */
  refresh: () => Promise<void>;
  /** Applies a status from an import result, without another read. */
  apply: (status: CleanupModelStatus) => void;
  /** Shows an error from outside the status read (a failed import). */
  fail: (reason: unknown) => void;
  /** Clears the import-failure line before a new import attempt. */
  clearImportError: () => void;
  /** The native store, created lazily. */
  store: () => CleanupModelStore;
}

/**
 * The one visibility rule for everything about local cleanup (BUS-16 PR 2c):
 * the Local cleanup block in Capture and both writing-style captions. Show it
 * when the native status reports a bundled worker, when cleanup is already
 * active (so it can be turned off), or in dev builds. Production builds
 * without a worker show none of it; PR 3's worker lights it up, no flag.
 *
 * A failed status read leaves the worker unknown, so a production build
 * keeps the block hidden then (Sophie's call, BUS-16 PR 3a): no build ships a
 * worker yet, and the frontend has no bundled-worker signal before the read.
 * Dev builds always show it, error and Check again included. PR 3c, which
 * bundles the worker, must show the error block on worker-bundled builds
 * (Codex 4315232707).
 */
export function cleanupShown(
  model: Pick<CleanupModel, 'workerAvailable'>,
  active: boolean,
): boolean {
  return model.workerAvailable || active || import.meta.env.DEV;
}

const BROWSER: CleanupModelView = { kind: 'browser' };
const noop = () => {};

/**
 * The window's shared cleanup model status (see `cleanupModelCache`). Every
 * consumer sees one result; mounting another one never re-reads it.
 * `modelStore` is a test seam.
 */
export function useCleanupModel(isNative: boolean, modelStore?: CleanupModelStore): CleanupModel {
  if (isNative) cleanupModelCache.useStore(modelStore);
  const shared = useSyncExternalStore(cleanupModelCache.subscribe, cleanupModelCache.snapshot);
  useEffect(() => {
    if (isNative) cleanupModelCache.ensureLoaded();
  }, [isNative]);
  if (!isNative) {
    return {
      apply: noop, clearImportError: noop, fail: noop, importError: null,
      refresh: async () => {}, store: cleanupModelCache.store, view: BROWSER, workerAvailable: false,
    };
  }
  return {
    apply: cleanupModelCache.apply,
    clearImportError: cleanupModelCache.clearImportError,
    fail: cleanupModelCache.fail,
    importError: shared.importError,
    refresh: cleanupModelCache.refresh,
    store: cleanupModelCache.store,
    view: shared.view,
    workerAvailable: shared.workerAvailable,
  };
}
