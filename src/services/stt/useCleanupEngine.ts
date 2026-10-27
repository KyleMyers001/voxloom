/// Native cleanup engine lifecycle for dogfood capture (BUS-16): created on
/// first use and disposed on unmount, so StrictMode and reloads never leave
/// a native cleanup session open.

import { useCallback, useRef } from 'react';
import type { CleanupEngine } from '../cleanup/contracts';
import { createTauriCleanupEngine } from '../cleanup/tauriAdapter';

export interface CleanupEngineLifecycle {
  /** The injected engine, else the lazily created native one. Stable. */
  cleanupEngine: () => CleanupEngine;
  /** Disposes the native engine if one was created. Stable; call on unmount. */
  disposeNativeEngine: () => void;
}

export function useCleanupEngine(injected?: CleanupEngine): CleanupEngineLifecycle {
  const injectedEngineRef = useRef(injected);
  injectedEngineRef.current = injected;
  const nativeEngineRef = useRef<CleanupEngine | null>(null);
  const cleanupEngine = useCallback((): CleanupEngine => injectedEngineRef.current
    ?? (nativeEngineRef.current ??= createTauriCleanupEngine()), []);
  const disposeNativeEngine = useCallback(() => {
    const engine = nativeEngineRef.current;
    nativeEngineRef.current = null;
    void engine?.dispose?.().catch(() => {
      console.warn('Cleanup session disposal failed; the native side reclaims it.');
    });
  }, []);
  return { cleanupEngine, disposeNativeEngine };
}
