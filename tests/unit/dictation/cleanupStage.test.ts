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
});
