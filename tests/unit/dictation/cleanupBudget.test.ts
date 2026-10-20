// @vitest-environment node
// BUS-16 3c-2c-C1: one 10 s end-to-end cleanup budget across the lease, the
// re-hash and the run, the word threshold, and the time left the run gets.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLEANUP_BUDGET_MS, CLEANUP_MAX_WORDS, tooLongToClean, wordCount,
} from '../../../src/services/cleanup/budget';
import type { CleanupEngine } from '../../../src/services/cleanup/contracts';
import { runCleanup } from '../../../src/services/cleanup/runCleanup';
import {
  CLEANUP_MODEL_ID, CLEANUP_MODEL_SHA256, type CleanupRequest, type CleanupSnapshot,
} from '../../../src/services/cleanup/types';
import {
  CLEANUP_STAGE_TIMEOUT_MS, cleanTranscript, type CleanupStageInput,
} from '../../../src/services/dictation/cleanupStage';
import { signalFor } from '../../../src/services/dictation/signal';

const attempt = { modelDigest: CLEANUP_MODEL_SHA256, modelId: CLEANUP_MODEL_ID };
const snapshot: CleanupSnapshot = {
  dictionary: [], enabled: true, modelId: CLEANUP_MODEL_ID, style: 'formal',
};
const RAW = 'um send it';

function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => { setTimeout(() => resolve(value), ms); });
}

/** The lease takes `leaseMs`; the run (re-hash plus worker) takes `runMs`. */
function timedEngine(leaseMs: number, runMs: number) {
  return {
    acquire: vi.fn(() => after(leaseMs, undefined)),
    cancel: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    // The request is read back through mock.calls.
    run: vi.fn((request: CleanupRequest) => after(runMs, { attempt, text: request && 'Send it.' })),
  } satisfies CleanupEngine;
}

function stage(engine: CleanupEngine, rawText = RAW): CleanupStageInput {
  return {
    engine, rawText, requestId: 'b-1', signal: signalFor(new AbortController()),
    snapshot, userCancelled: () => false,
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('the cleanup budget', () => {
  it('is one 10 s constant, used by the stage and by runCleanup', () => {
    expect(CLEANUP_BUDGET_MS).toBe(10_000);
    expect(CLEANUP_STAGE_TIMEOUT_MS).toBe(CLEANUP_BUDGET_MS);
  });

  it('cleans when lease plus run fit, and the run gets what the lease left', async () => {
    vi.useFakeTimers();
    const engine = timedEngine(4_000, 5_900);
    const pending = cleanTranscript(stage(engine));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(engine.run).toHaveBeenCalledOnce();
    expect(engine.run.mock.calls[0][0].timeLeftMs).toBe(6_000);
    await vi.advanceTimersByTimeAsync(5_900);
    await expect(pending).resolves.toMatchObject({ status: 'cleaned' });
  });

  it('times out at 10 s from the start when lease plus run do not fit', async () => {
    vi.useFakeTimers();
    const engine = timedEngine(6_000, 5_000);
    let settled = false;
    const pending = cleanTranscript(stage(engine)).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({
      finalText: RAW, reason: 'timeout', status: 'fallback',
    });
    expect(engine.cancel).toHaveBeenCalledWith('b-1');
  });

  it('a slow lease (the model hash) alone uses up the budget', async () => {
    vi.useFakeTimers();
    const engine = timedEngine(11_000, 1);
    const pending = cleanTranscript(stage(engine));
    await vi.advanceTimersByTimeAsync(CLEANUP_BUDGET_MS);
    await expect(pending).resolves.toMatchObject({ reason: 'timeout', status: 'fallback' });
    expect(engine.run).not.toHaveBeenCalled();
  });

  it('runCleanup on its own defaults to the budget and passes it as time left', async () => {
    vi.useFakeTimers();
    const engine = timedEngine(0, 60_000);
    const pending = runCleanup({
      engine, rawText: RAW, requestId: 'b-2', signal: signalFor(new AbortController()), snapshot,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.run.mock.calls[0][0].timeLeftMs).toBe(CLEANUP_BUDGET_MS);
    await vi.advanceTimersByTimeAsync(CLEANUP_BUDGET_MS - 1);
    let settled = false;
    void pending.finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ reason: 'timeout', status: 'fallback' });
  });
});

describe('the word threshold', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

  it('counts whitespace-separated words', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('  one\ttwo\nthree  ')).toBe(3);
    expect(CLEANUP_MAX_WORDS).toBe(120);
    expect(tooLongToClean(words(120))).toBe(false);
    expect(tooLongToClean(words(121))).toBe(true);
  });

  it('cleans 120 words', async () => {
    const engine = timedEngine(0, 0);
    engine.run.mockResolvedValue({ attempt, text: words(120) });
    await expect(cleanTranscript(stage(engine, words(120))))
      .resolves.toMatchObject({ status: 'cleaned' });
    expect(engine.run).toHaveBeenCalledOnce();
  });

  it('delivers 121 words raw without a lease, hash or worker', async () => {
    const engine = timedEngine(0, 0);
    const raw = words(121);
    await expect(cleanTranscript(stage(engine, raw))).resolves.toEqual({
      finalText: raw, reason: 'context-overflow', status: 'fallback',
    });
    expect(engine.acquire).not.toHaveBeenCalled();
    expect(engine.run).not.toHaveBeenCalled();
  });

  it('still skips, not falls back, when cleanup is off', async () => {
    const engine = timedEngine(0, 0);
    const input = { ...stage(engine, words(500)), snapshot: { ...snapshot, enabled: false } };
    await expect(cleanTranscript(input)).resolves.toMatchObject({ status: 'skipped' });
  });
});
