import { useCallback, useEffect, useRef, useState } from 'react';
import type { CleanupModelStore } from '../../services/cleanup/contracts';
import { createTauriCleanupModelStore } from '../../services/cleanup/tauriAdapter';
import type { CleanupModelView } from './cleanupCopy';

const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

export interface CleanupModel {
  /** Transient: checking, an error, or the latest status. */
  view: CleanupModelView;
  /**
   * Last known `runtimeAvailable`. Unknown (never read) counts as false. A
   * later check or error keeps the last known value, so Check again, the
   * post-import refresh or an import error never hide the block mid-use.
   */
  workerAvailable: boolean;
  /** Re-reads `cleanup_model_status`. */
  refresh: () => Promise<void>;
  /** Shows an error from outside the status read (a failed import). */
  fail: (reason: unknown) => void;
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

/** Cleanup model status from the native side; `modelStore` is a test seam. */
export function useCleanupModel(isNative: boolean, modelStore?: CleanupModelStore): CleanupModel {
  const [view, setView] = useState<CleanupModelView>(
    isNative ? { kind: 'checking' } : { kind: 'browser' },
  );
  const storeRef = useRef<CleanupModelStore | null>(modelStore ?? null);
  if (modelStore) storeRef.current = modelStore;
  const generation = useRef(0);
  const [workerAvailable, setWorkerAvailable] = useState(false);
  const store = useCallback(() => storeRef.current ??= createTauriCleanupModelStore(), []);

  const refresh = useCallback(async () => {
    if (!isNative) return;
    const request = ++generation.current;
    setView({ kind: 'checking' });
    try {
      const status = await store().status();
      // Native IPC result: check its shape before trusting it.
      if (typeof status?.available !== 'boolean' || typeof status.runtimeAvailable !== 'boolean'
        || typeof status.id !== 'string') {
        throw new Error('unexpected status from the app');
      }
      if (request === generation.current) {
        setView({ kind: 'status', status });
        setWorkerAvailable(status.runtimeAvailable);
      }
    } catch (reason: unknown) {
      if (request === generation.current) setView({ kind: 'error', message: message(reason) });
    }
  }, [isNative, store]);

  useEffect(() => {
    void refresh();
    return () => { generation.current++; };
  }, [refresh]);

  const fail = useCallback((reason: unknown) => {
    generation.current++;
    setView({ kind: 'error', message: message(reason) });
  }, []);

  return { fail, refresh, store, view, workerAvailable };
}
