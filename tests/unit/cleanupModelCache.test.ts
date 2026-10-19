// BUS-16 PR 2c (#105 CR P3-2/P3-4): the per-window cleanup model status cache.
import { describe, expect, it, vi } from 'vitest';
import { cleanupModelCache } from '../../src/features/settings/cleanupModelCache';
import type { CleanupModelStore } from '../../src/services/cleanup/contracts';
import { CLEANUP_MODEL_ID, CLEANUP_MODEL_SHA256, type CleanupModelStatus } from '../../src/services/cleanup/types';

const ready: CleanupModelStatus = {
  available: true, id: CLEANUP_MODEL_ID, runtimeAvailable: true, sha256: CLEANUP_MODEL_SHA256,
};
const noWorker: CleanupModelStatus = { ...ready, runtimeAvailable: false };

/** A store whose status calls each wait for the test to answer them. */
function deferredStore() {
  const answers: { reject: (error: Error) => void; resolve: (status: CleanupModelStatus) => void }[] = [];
  const store: CleanupModelStore = {
    importModel: vi.fn(),
    status: vi.fn(() => new Promise<CleanupModelStatus>((resolve, reject) => { answers.push({ reject, resolve }); })),
  };
  cleanupModelCache.useStore(store);
  return { answers, store };
}

const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });
const view = () => cleanupModelCache.snapshot().view;
const worker = () => cleanupModelCache.snapshot().workerAvailable;

describe('cleanupModelCache', () => {
  it('a failed first read is retried by the next consumer', async () => {
    const { answers, store } = deferredStore();
    cleanupModelCache.ensureLoaded();
    answers[0].reject(new Error('denied'));
    await flush();
    expect(view()).toEqual({ kind: 'error', message: 'denied' });
    cleanupModelCache.ensureLoaded();
    expect(store.status).toHaveBeenCalledTimes(2);
    answers[1].resolve(ready);
    await flush();
    expect(view()).toEqual({ kind: 'status', status: ready });
    cleanupModelCache.ensureLoaded();
    expect(store.status).toHaveBeenCalledTimes(2);
  });

  it('once a status is known, a later error does not re-read on the next mount', async () => {
    const { answers, store } = deferredStore();
    cleanupModelCache.ensureLoaded();
    answers[0].resolve(ready);
    await flush();
    void cleanupModelCache.refresh();
    answers[1].reject(new Error('denied'));
    await flush();
    cleanupModelCache.ensureLoaded();
    expect(store.status).toHaveBeenCalledTimes(2);
    expect(worker()).toBe(true);
  });

  it('an import result supersedes an in-flight Check again', async () => {
    const { answers } = deferredStore();
    void cleanupModelCache.refresh();
    cleanupModelCache.apply(ready);
    expect(view()).toEqual({ kind: 'status', status: ready });
    answers[0].resolve(noWorker);
    await flush();
    expect(view()).toEqual({ kind: 'status', status: ready });
    expect(worker()).toBe(true);
  });

  it('an import failure supersedes an in-flight Check again', async () => {
    const { answers } = deferredStore();
    void cleanupModelCache.refresh();
    cleanupModelCache.fail(new Error('picker exploded'));
    answers[0].resolve(ready);
    await flush();
    expect(view()).toEqual({ kind: 'error', message: 'picker exploded' });
    expect(worker()).toBe(false);
  });

  it('a stale error is ignored', async () => {
    const { answers } = deferredStore();
    void cleanupModelCache.refresh();
    void cleanupModelCache.refresh();
    answers[1].resolve(ready);
    await flush();
    answers[0].reject(new Error('stale'));
    await flush();
    expect(view()).toEqual({ kind: 'status', status: ready });
  });

  it.each([
    ['no runtime flag', { ...ready, runtimeAvailable: undefined }],
    ['a non-string id', { ...ready, id: 7 }],
    ['nothing', null],
  ])('apply rejects a malformed import status (%s) and keeps the worker flag', async (_label, bad) => {
    const { answers } = deferredStore();
    cleanupModelCache.ensureLoaded();
    answers[0].resolve(ready);
    await flush();
    cleanupModelCache.apply(bad as unknown as CleanupModelStatus);
    expect(view()).toEqual({ kind: 'error', message: 'unexpected status from the app' });
    expect(worker()).toBe(true);
  });
});
