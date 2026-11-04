// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CleanupEngine } from '../../../src/services/cleanup/contracts';
import {
  CLEANUP_MODEL_ID,
  CLEANUP_MODEL_SHA256,
  CleanupEngineError,
  type CleanupSnapshot,
} from '../../../src/services/cleanup/types';
import {
  cleanTranscript,
  type CleanupStageInput,
} from '../../../src/services/dictation/cleanupStage';
import { signalFor } from '../../../src/services/dictation/signal';
import { CLEANUP_MAX_WORDS } from '../../../src/services/cleanup/budget';

const attempt = { modelDigest: CLEANUP_MODEL_SHA256, modelId: CLEANUP_MODEL_ID };
const snapshot: CleanupSnapshot = {
  dictionary: ['Voxloom'], enabled: true, modelId: CLEANUP_MODEL_ID, style: 'formal',
};

function engine(overrides: Partial<CleanupEngine> = {}) {
  return {
    acquire: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue({ attempt, text: 'Send to Voxloom.' }),
    ...overrides,
  } satisfies CleanupEngine;
}

function input(overrides: Partial<CleanupStageInput> = {}): CleanupStageInput {
  return {
    engine: engine(),
    rawText: 'um send to voxlom',
    requestId: 'cleanup-a',
    signal: signalFor(new AbortController()),
    snapshot,
    userCancelled: () => false,
    ...overrides,
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('cleanTranscript', () => {
  it('skips without touching the engine when off or blank', async () => {
    const off = engine();
    await expect(cleanTranscript(input({ engine: off, snapshot: { ...snapshot, enabled: false } })))
      .resolves.toEqual({ finalText: 'um send to voxlom', status: 'skipped' });
    await expect(cleanTranscript(input({ engine: off, rawText: '   ' })))
      .resolves.toMatchObject({ status: 'skipped' });
    expect(off.acquire).not.toHaveBeenCalled();
    expect(off.run).not.toHaveBeenCalled();
  });

  it('acquires, runs, validates and releases', async () => {
    const live = engine();
    const outcome = await cleanTranscript(input({ engine: live }));
    expect(outcome).toEqual({ attempt, finalText: 'Send to Voxloom.', status: 'cleaned' });
    expect(live.acquire).toHaveBeenCalledWith('cleanup-a', CLEANUP_MODEL_ID);
    expect(live.run).toHaveBeenCalledOnce();
    expect(live.release).toHaveBeenCalledWith('cleanup-a');
  });

  it.each([
    ['validator reject', { run: vi.fn().mockResolvedValue({ attempt, text: 'Send the password.' }) }, 'invalid-output'],
    ['reasoning leak', { run: vi.fn().mockResolvedValue({ attempt, text: '<think>x</think>' }) }, 'invalid-output'],
    ['worker error', { run: vi.fn().mockRejectedValue(new CleanupEngineError('runtime-error', 'boom')) }, 'runtime-error'],
    ['missing worker', { run: vi.fn().mockRejectedValue(new Error('not a CleanupEngineError')) }, 'runtime-error'],
    // BUS-135: the worker vanished between the lease and the run.
    ['worker gone at run', { run: vi.fn().mockRejectedValue(new CleanupEngineError('worker-missing', 'gone')) }, 'worker-missing'],
    ['lease failure', { acquire: vi.fn().mockRejectedValue(new CleanupEngineError('model-missing', 'no model')) }, 'model-missing'],
    ['native retirement', { run: vi.fn().mockRejectedValue(new CleanupEngineError('cancelled', 'retired')) }, 'cancelled'],
  ])('falls back to the raw text on %s', async (_label, overrides, reason) => {
    const live = engine(overrides);
    await expect(cleanTranscript(input({ engine: live }))).resolves.toMatchObject({
      finalText: 'um send to voxlom', reason, status: 'fallback',
    });
    expect(live.release).toHaveBeenCalledWith('cleanup-a');
  });

  it('falls back when no model is selected', async () => {
    const live = engine();
    await expect(cleanTranscript(input({ engine: live, snapshot: { ...snapshot, modelId: null } })))
      .resolves.toMatchObject({ reason: 'model-missing', status: 'fallback' });
    expect(live.run).not.toHaveBeenCalled();
  });

  it('times out a lease that never settles and still releases', async () => {
    vi.useFakeTimers();
    const live = engine({ acquire: vi.fn(() => new Promise<void>(() => {})) });
    const pending = cleanTranscript(input({ engine: live, timeoutMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({
      finalText: 'um send to voxlom', reason: 'timeout', status: 'fallback',
    });
    expect(live.run).not.toHaveBeenCalled();
    expect(live.release).toHaveBeenCalledWith('cleanup-a');
  });

  it('shares one deadline between the lease and the run', async () => {
    vi.useFakeTimers();
    const live = engine({
      acquire: vi.fn(() => new Promise<void>((resolve) => { setTimeout(resolve, 800); })),
      run: vi.fn(() => new Promise<never>(() => {})),
    });
    const pending = cleanTranscript(input({ engine: live, timeoutMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(999);
    expect(live.run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ reason: 'timeout', status: 'fallback' });
    expect(live.cancel).toHaveBeenCalledWith('cleanup-a');
  });

  it('a user cancel during the run delivers nothing', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const live = engine({ run: vi.fn(() => new Promise<never>(() => {})) });
    const pending = cleanTranscript(input({
      engine: live, signal: signalFor(controller), userCancelled: () => cancelled,
    }));
    await vi.waitFor(() => expect(live.run).toHaveBeenCalled());
    cancelled = true;
    controller.abort();
    await expect(pending).resolves.toEqual({ reason: 'cancelled', status: 'cancelled' });
    expect(live.cancel).toHaveBeenCalledWith('cleanup-a');
  });

  it('a user cancel during the lease delivers nothing and never runs', async () => {
    const controller = new AbortController();
    const live = engine({ acquire: vi.fn(() => new Promise<void>(() => {})) });
    const pending = cleanTranscript(input({
      engine: live, signal: signalFor(controller), userCancelled: () => true,
    }));
    controller.abort();
    await expect(pending).resolves.toEqual({ reason: 'cancelled', status: 'cancelled' });
    expect(live.run).not.toHaveBeenCalled();
  });

  it('a superseded run (aborted, not user-cancelled) keeps the raw text', async () => {
    const controller = new AbortController();
    const live = engine({ run: vi.fn(() => new Promise<never>(() => {})) });
    const pending = cleanTranscript(input({ engine: live, signal: signalFor(controller) }));
    await vi.waitFor(() => expect(live.run).toHaveBeenCalled());
    controller.abort();
    await expect(pending).resolves.toEqual({
      finalText: 'um send to voxlom', reason: 'cancelled', status: 'fallback',
    });
  });

  it('a release failure does not change the outcome', async () => {
    const live = engine({ release: vi.fn().mockRejectedValue(new Error('gone')) });
    await expect(cleanTranscript(input({ engine: live }))).resolves.toMatchObject({ status: 'cleaned' });
  });

  it('removes its abort listeners once settled', async () => {
    const removers: ReturnType<typeof vi.fn>[] = [];
    const signal = {
      aborted: false,
      onAbort: vi.fn(() => {
        const remove = vi.fn();
        removers.push(remove);
        return remove;
      }),
    };
    await cleanTranscript(input({ signal }));
    // One listener for the lease, one inside runCleanup.
    expect(removers).toHaveLength(2);
    for (const remove of removers) expect(remove).toHaveBeenCalledOnce();
  });

  it('clears the lease timer once the lease settles', async () => {
    vi.useFakeTimers();
    const pending = cleanTranscript(input({ engine: engine({ run: vi.fn(() => new Promise<never>(() => {})) }) }));
    await vi.advanceTimersByTimeAsync(0);
    // Only the run's own deadline is left; the lease timer is gone.
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toMatchObject({ reason: 'timeout', status: 'fallback' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an unexpected throw still delivers the raw text', async () => {
    const throwing = engine({ acquire: vi.fn(() => { throw new Error('sync boom'); }) });
    await expect(cleanTranscript(input({ engine: throwing }))).resolves.toEqual({
      finalText: 'um send to voxlom', reason: 'runtime-error', status: 'fallback',
    });
    expect(throwing.run).not.toHaveBeenCalled();
  });

  it('an unexpected throw after the user cancelled delivers nothing', async () => {
    const throwing = engine({ acquire: vi.fn(() => { throw new Error('sync boom'); }) });
    await expect(cleanTranscript(input({ engine: throwing, userCancelled: () => true })))
      .resolves.toEqual({ reason: 'cancelled', status: 'cancelled' });
  });

  it('a release that throws synchronously does not change the outcome', async () => {
    const live = engine({ release: vi.fn(() => { throw new Error('sync release'); }) });
    await expect(cleanTranscript(input({ engine: live }))).resolves.toMatchObject({ status: 'cleaned' });
    await Promise.resolve();
    expect(live.release).toHaveBeenCalledWith('cleanup-a');
  });

  it('a superseded run whose cancel hangs still returns raw text within the grace', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const hung = engine({
      cancel: vi.fn(() => new Promise<void>(() => {})),
      run: vi.fn(() => new Promise<never>(() => {})),
    });
    let settled: unknown = 'pending';
    void cleanTranscript(input({ engine: hung, signal: signalFor(controller) }))
      .then((outcome) => { settled = outcome; });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe('pending');
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toMatchObject({ finalText: 'um send to voxlom', reason: 'cancelled', status: 'fallback' });
  });
  describe('cancellation before the word-count fast path (BUS-122)', () => {
    const longText = Array.from({ length: CLEANUP_MAX_WORDS + 1 }, () => 'word').join(' ');

    it('a user cancel with a too-long transcript delivers nothing, as the normal path does', async () => {
      const controller = new AbortController();
      controller.abort();
      const live = engine();
      await expect(cleanTranscript(input({
        engine: live, rawText: longText, signal: signalFor(controller), userCancelled: () => true,
      }))).resolves.toEqual({ reason: 'cancelled', status: 'cancelled' });
      expect(live.acquire).not.toHaveBeenCalled();
      expect(live.run).not.toHaveBeenCalled();
    });

    it('a superseded too-long run (aborted, not user-cancelled) keeps the raw text as cancelled', async () => {
      const controller = new AbortController();
      controller.abort();
      const live = engine();
      await expect(cleanTranscript(input({
        engine: live, rawText: longText, signal: signalFor(controller),
      }))).resolves.toEqual({ finalText: longText, reason: 'cancelled', status: 'fallback' });
      expect(live.acquire).not.toHaveBeenCalled();
      expect(live.run).not.toHaveBeenCalled();
    });

    it('a user cancel flagged before the signal aborts still delivers nothing', async () => {
      await expect(cleanTranscript(input({ rawText: longText, userCancelled: () => true })))
        .resolves.toEqual({ reason: 'cancelled', status: 'cancelled' });
    });

    it('a too-long transcript that is not cancelled still falls back to context-overflow', async () => {
      const live = engine();
      await expect(cleanTranscript(input({ engine: live, rawText: longText }))).resolves.toEqual({
        finalText: longText, reason: 'context-overflow', status: 'fallback',
      });
      expect(live.acquire).not.toHaveBeenCalled();
      expect(live.run).not.toHaveBeenCalled();
    });
  });

  describe('monotonic cleanup deadline (BUS-123)', () => {
    /** A lease that settles when the test says so, with the clock it runs on. */
    function pendingLease() {
      let settle: () => void = () => {};
      const acquire = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
      return { acquire, settle: () => settle() };
    }

    it.each([
      ['steps back', -60_000],
      ['steps forward', 60_000],
    ])('a wall clock that %s during the lease does not change the time left for the run', async (_label, step) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const lease = pendingLease();
      const live = engine({ acquire: lease.acquire });
      const pending = cleanTranscript(input({ engine: live, timeoutMs: 5_000 }));
      await vi.advanceTimersByTimeAsync(1_000);
      vi.setSystemTime(Date.now() + step);
      lease.settle();
      await vi.advanceTimersByTimeAsync(0);
      expect(live.run).toHaveBeenCalledOnce();
      // 1 s of the lease is gone, whatever the wall clock says.
      expect(vi.mocked(live.run).mock.calls[0]?.[0].timeLeftMs).toBe(4_000);
      await expect(pending).resolves.toMatchObject({ status: 'cleaned' });
    });

    it('counts the run budget on the injected monotonic clock', async () => {
      let tick = 5_000;
      const lease = pendingLease();
      const live = engine({ acquire: lease.acquire });
      const pending = cleanTranscript(input({ engine: live, now: () => tick, timeoutMs: 10_000 }));
      await vi.waitFor(() => expect(lease.acquire).toHaveBeenCalled());
      tick += 2_500;
      lease.settle();
      await expect(pending).resolves.toMatchObject({ status: 'cleaned' });
      expect(vi.mocked(live.run).mock.calls[0]?.[0].timeLeftMs).toBe(7_500);
    });

    it('rounds a fractional time left down to a whole number for native', async () => {
      let tick = 100.25;
      const lease = pendingLease();
      const live = engine({ acquire: lease.acquire });
      const pending = cleanTranscript(input({ engine: live, now: () => tick, timeoutMs: 10_000 }));
      await vi.waitFor(() => expect(lease.acquire).toHaveBeenCalled());
      tick += 5_500.5;
      lease.settle();
      await pending;
      const left = vi.mocked(live.run).mock.calls[0]?.[0].timeLeftMs;
      expect(left).toBe(4_499);
      expect(Number.isInteger(left)).toBe(true);
    });

    it('leaves at least 1 ms when the lease used the whole budget', async () => {
      let tick = 0;
      const lease = pendingLease();
      const live = engine({ acquire: lease.acquire });
      const pending = cleanTranscript(input({ engine: live, now: () => tick, timeoutMs: 1_000 }));
      await vi.waitFor(() => expect(lease.acquire).toHaveBeenCalled());
      tick += 5_000;
      lease.settle();
      await pending;
      expect(vi.mocked(live.run).mock.calls[0]?.[0].timeLeftMs).toBe(1);
    });
  });
});
