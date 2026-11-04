// BUS-16 PR 2c (#105) + BUS-101 / BUS-106: per-window cleanup model status cache.
import { describe, expect, it, vi } from 'vitest';
import { cleanupModelCache } from '../../src/features/settings/cleanupModelCache';
import type { CleanupModelStore } from '../../src/services/cleanup/contracts';
import { CleanupEngineError, type CleanupModelStatus } from '../../src/services/cleanup/types';
import {
  deferredStore, flush, noWorker, ready, view, worker,
} from './cleanupModelCacheFixtures';
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
  });

  it.each([
    ['no runtime flag', { ...ready, runtimeAvailable: undefined }],
    ['a non-string id', { ...ready, id: 7 }],
    ['nothing', null],
  ])('apply throws on a malformed download status (%s) and keeps the worker flag', async (_label, bad) => {
    const { answers } = deferredStore();
    cleanupModelCache.ensureLoaded();
    answers[0].resolve(ready);
    await flush();
    expect(() => cleanupModelCache.apply(bad as unknown as CleanupModelStatus))
      .toThrow('unexpected status from the app');
    expect(view()).toEqual({ kind: 'status', status: ready });
    expect(worker()).toBe(true);
  });

  it('shows CleanupEngineError.message from a structured native rejection', async () => {
    const { answers } = deferredStore();
    cleanupModelCache.ensureLoaded();
    answers[0].reject(new CleanupEngineError('runtime-error', 'cleanup model is in use'));
    await flush();
    expect(view()).toEqual({ kind: 'error', message: 'cleanup model is in use' });
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

  // BUS-112 item 1: a cancelled read finishing must not free the newer slot.
  it('own-slot guard: a stale read settling leaves the newer read shared', async () => {
    const { answers, store } = deferredStore();
    const first = cleanupModelCache.refresh();
    cleanupModelCache.apply(ready); // supersedes the first read
    const second = cleanupModelCache.refresh();
    expect(store.status).toHaveBeenCalledTimes(2);
    answers[0].reject(new Error('io')); // stale; ignored
    await first;
    await flush();
    expect(cleanupModelCache.refresh()).toBe(second);
    expect(store.status).toHaveBeenCalledTimes(2);
    answers[1].resolve(noWorker);
    await second;
    expect(view()).toEqual({ kind: 'status', status: noWorker });
  });

  it('refresh after apply during an in-flight read starts a new status call', async () => {
    const { answers, store } = deferredStore();
    cleanupModelCache.ensureLoaded();
    expect(store.status).toHaveBeenCalledTimes(1);
    cleanupModelCache.apply(noWorker);
    expect(view()).toEqual({ kind: 'status', status: noWorker });
    void cleanupModelCache.refresh();
    expect(store.status).toHaveBeenCalledTimes(2);
    answers[0].resolve(ready); // cancelled; ignored
    answers[1].resolve(ready);
    await flush();
    expect(view()).toEqual({ kind: 'status', status: ready });
    expect(worker()).toBe(true);
  });

  // CR Low #3: status() throwing sync must not stick a settled promise in `reading`.
  it('a sync throw from status() still lets the next refresh call status again', async () => {
    const store: CleanupModelStore = {
      
      status: vi.fn()
        .mockImplementationOnce(() => { throw new Error('sync boom'); })
        .mockResolvedValueOnce(ready),
    };
    cleanupModelCache.useStore(store);
    await cleanupModelCache.refresh();
    expect(view()).toEqual({ kind: 'error', message: 'sync boom' });
    await cleanupModelCache.refresh();
    expect(store.status).toHaveBeenCalledTimes(2);
    expect(view()).toEqual({ kind: 'status', status: ready });
  });

});
