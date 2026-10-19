// BUS-16 PR 2c (#105) + BUS-101 / BUS-106: per-window cleanup model status cache.
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
const importError = () => cleanupModelCache.snapshot().importError;

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

  it('an import failure keeps a known status and sets importError (BUS-101)', async () => {
    const { answers } = deferredStore();
    cleanupModelCache.ensureLoaded();
    answers[0].resolve(ready);
    await flush();
    void cleanupModelCache.refresh();
    cleanupModelCache.fail(new Error('picker exploded'));
    answers[1].resolve(noWorker);
    await flush();
    expect(view()).toEqual({ kind: 'status', status: ready });
    expect(importError()).toBe('picker exploded');
    expect(worker()).toBe(true);
  });

  it('Check again and a new import clear the import-failure line', async () => {
    const { answers } = deferredStore();
    cleanupModelCache.ensureLoaded();
    answers[0].resolve(ready);
    await flush();
    cleanupModelCache.fail(new Error('bad file'));
    expect(importError()).toBe('bad file');
    cleanupModelCache.clearImportError();
    expect(importError()).toBeNull();
    cleanupModelCache.fail(new Error('bad file'));
    void cleanupModelCache.refresh();
    expect(importError()).toBeNull();
    answers[1].resolve(ready);
    await flush();
  });

  it('overlapping refresh calls share one status read (BUS-106)', async () => {
    const { answers, store } = deferredStore();
    const first = cleanupModelCache.refresh();
    const second = cleanupModelCache.refresh();
    expect(store.status).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    answers[0].resolve(ready);
    await first;
    expect(view()).toEqual({ kind: 'status', status: ready });
  });

  it('a stale error is ignored', async () => {
    const { answers } = deferredStore();
    void cleanupModelCache.refresh();
    answers[0].resolve(ready);
    await flush();
    // After the first completes, start another and supersede it with apply.
    void cleanupModelCache.refresh();
    cleanupModelCache.apply(ready);
    answers[1].reject(new Error('stale'));
    await flush();
    expect(view()).toEqual({ kind: 'status', status: ready });
    expect(importError()).toBeNull();
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
    expect(view()).toEqual({ kind: 'status', status: ready });
    expect(importError()).toBe('unexpected status from the app');
    expect(worker()).toBe(true);
  });

  // BUS-106: the four surviving #105 mutations (apply :84–85, :88; fail :94).
  it('apply before any status read marks the cache loaded (mutation :84)', async () => {
    const { answers, store } = deferredStore();
    cleanupModelCache.apply(ready);
    expect(view()).toEqual({ kind: 'status', status: ready });
    void cleanupModelCache.refresh();
    answers[0].reject(new Error('denied'));
    await flush();
    cleanupModelCache.ensureLoaded();
    // If apply skipped `loaded = true`, ensureLoaded would re-read after the error.
    expect(store.status).toHaveBeenCalledTimes(1);
  });

  it('apply before any status read marks the cache requested (mutation :85)', async () => {
    const { store } = deferredStore();
    cleanupModelCache.apply(ready);
    cleanupModelCache.ensureLoaded();
    // If apply skipped `requested = true`, ensureLoaded would hash again.
    expect(store.status).not.toHaveBeenCalled();
  });

  it('a malformed apply before any load lets the next consumer retry (mutation :88)', async () => {
    const { answers, store } = deferredStore();
    cleanupModelCache.ensureLoaded();
    expect(store.status).toHaveBeenCalledTimes(1);
    cleanupModelCache.apply({ ...ready, id: 7 } as unknown as CleanupModelStatus);
    expect(importError()).toBe('unexpected status from the app');
    answers[0].resolve(ready); // stale in-flight read; generation already bumped
    await flush();
    cleanupModelCache.ensureLoaded();
    expect(store.status).toHaveBeenCalledTimes(2);
    answers[1].resolve(ready);
    await flush();
    expect(view()).toEqual({ kind: 'status', status: ready });
  });

  it('an import fail before any load lets the next consumer retry (mutation :94)', async () => {
    const { answers, store } = deferredStore();
    cleanupModelCache.ensureLoaded();
    cleanupModelCache.fail(new Error('picker exploded'));
    expect(importError()).toBe('picker exploded');
    answers[0].resolve(ready);
    await flush();
    cleanupModelCache.ensureLoaded();
    expect(store.status).toHaveBeenCalledTimes(2);
    answers[1].resolve(ready);
    await flush();
    expect(view()).toEqual({ kind: 'status', status: ready });
  });
});
