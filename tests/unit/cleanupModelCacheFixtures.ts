// Shared helpers for the cleanupModelCache unit tests.
import { vi } from 'vitest';
import { cleanupModelCache } from '../../src/features/settings/cleanupModelCache';
import type { CleanupModelStore } from '../../src/services/cleanup/contracts';
import { CLEANUP_MODEL_ID, CLEANUP_MODEL_SHA256, type CleanupModelStatus } from '../../src/services/cleanup/types';

export const ready: CleanupModelStatus = {
  available: true, id: CLEANUP_MODEL_ID, runtimeAvailable: true, sha256: CLEANUP_MODEL_SHA256,
};
export const noWorker: CleanupModelStatus = { ...ready, runtimeAvailable: false };

/** A store whose status calls each wait for the test to answer them. */
export function deferredStore() {
  const answers: { reject: (error: Error) => void; resolve: (status: CleanupModelStatus) => void }[] = [];
  const store: CleanupModelStore = {
    importModel: vi.fn(),
    status: vi.fn(() => new Promise<CleanupModelStatus>((resolve, reject) => { answers.push({ reject, resolve }); })),
  };
  cleanupModelCache.useStore(store);
  return { answers, store };
}

export const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });
export const view = () => cleanupModelCache.snapshot().view;
export const worker = () => cleanupModelCache.snapshot().workerAvailable;
export const importError = () => cleanupModelCache.snapshot().importError;
