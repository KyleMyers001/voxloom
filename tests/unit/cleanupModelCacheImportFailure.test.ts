// BUS-112 item 4: an import failure is never shown as a check failure. Before
// any status is known it leaves the view alone, and a first read still in
// flight lands (success or error) and keeps the import line.
import { describe, expect, it } from 'vitest';
import { cleanupModelCache } from '../../src/features/settings/cleanupModelCache';
import type { CleanupModelStatus } from '../../src/services/cleanup/types';
import { deferredStore, flush, importError, ready, view } from './cleanupModelCacheFixtures';

describe('cleanupModelCache: import failure before any status is known', () => {
  it('a malformed apply during the first read keeps that read', async () => {
    const { answers, store } = deferredStore();
    cleanupModelCache.ensureLoaded();
    expect(store.status).toHaveBeenCalledTimes(1);
    cleanupModelCache.apply({ ...ready, id: 7 } as unknown as CleanupModelStatus);
    expect(view()).toEqual({ kind: 'checking' });
    expect(importError()).toBe('unexpected status from the app');
    answers[0].resolve(ready);
    await flush();
    expect(view()).toEqual({ kind: 'status', status: ready });
    expect(importError()).toBe('unexpected status from the app');
    cleanupModelCache.ensureLoaded();
    expect(store.status).toHaveBeenCalledTimes(1);
  });

  it('an import fail during the first read keeps that read and the import line', async () => {
    const { answers, store } = deferredStore();
    cleanupModelCache.ensureLoaded();
    cleanupModelCache.fail(new Error('picker exploded'));
    expect(view()).toEqual({ kind: 'checking' });
    expect(importError()).toBe('picker exploded');
    answers[0].resolve(ready);
    await flush();
    expect(view()).toEqual({ kind: 'status', status: ready });
    expect(importError()).toBe('picker exploded');
    expect(store.status).toHaveBeenCalledTimes(1);
  });

  it('an import fail after a failed first read keeps the read error', async () => {
    const { answers, store } = deferredStore();
    cleanupModelCache.ensureLoaded();
    answers[0].reject(new Error('denied'));
    await flush();
    cleanupModelCache.fail(new Error('wrong file'));
    expect(view()).toEqual({ kind: 'error', message: 'denied' });
    expect(importError()).toBe('wrong file');
    // The failed read still lets the next consumer retry.
    cleanupModelCache.ensureLoaded();
    expect(store.status).toHaveBeenCalledTimes(2);
  });

  it('a first read failing after an import fail keeps the import line (CR Low)', async () => {
    const { answers } = deferredStore();
    cleanupModelCache.ensureLoaded();
    cleanupModelCache.fail('x');
    answers[0].reject(new Error('denied'));
    await flush();
    expect(view()).toEqual({ kind: 'error', message: 'denied' });
    expect(importError()).toBe('x');
  });
});
