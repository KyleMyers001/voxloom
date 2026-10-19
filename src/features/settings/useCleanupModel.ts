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
 */
export function cleanupShown(
  model: Pick<CleanupModel, 'workerAvailable'>,
  active: boolean,
): boolean {
  return model.workerAvailable || active || import.meta.env.DEV;
}

/**
 * The Local cleanup block itself also shows after a failed status read: the
 * worker is unknown then, and the error and Check again must stay reachable
 * (Codex 4315232707). The captions keep `cleanupShown`, so nothing mentions
 * cleanup on the strength of an error alone.
 */
export function cleanupBlockShown(
  model: Pick<CleanupModel, 'view' | 'workerAvailable'>,
  active: boolean,
): boolean {
  return cleanupShown(model, active) || model.view.kind === 'error';
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
