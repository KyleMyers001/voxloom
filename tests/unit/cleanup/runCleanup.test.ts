import { describe, expect, it, vi } from 'vitest';
import { runCleanup } from '../../../src/services/cleanup/runCleanup';
import { CleanupEngineError } from '../../../src/services/cleanup/types';
import type { ProcessingSignal } from
  '../../../src/services/dictation/signal';

function signal(): ProcessingSignal {
  return { aborted: false, onAbort: vi.fn() };
}

const snapshot = {
  dictionary: ['Voxloom'],
  enabled: true,
  modelId: 'qwen3-0.6b-q4-k-m',
  style: 'formal' as const,
};

describe('runCleanup', () => {
  it('leaves disabled cleanup byte-for-byte unchanged', async () => {
    const engine = { cancel: vi.fn(), run: vi.fn() };
    const outcome = await runCleanup({
      engine,
      rawText: ' raw ',
      requestId: 'r1',
      signal: signal(),
      snapshot: { ...snapshot, enabled: false },
    });
    expect(outcome).toEqual({ finalText: ' raw ', status: 'skipped' });
    expect(engine.run).not.toHaveBeenCalled();
  });

  it.each(['formal', 'casual', 'very-casual'] as const)(
    'applies dictionary and fidelity guards for %s', async (style) => {
      const engine = {
        cancel: vi.fn(),
        run: vi.fn().mockResolvedValueOnce('Send to Voxloom.')
          .mockResolvedValueOnce('Keep 50 items.'),
      };
      const common = { engine, requestId: 'r1', signal: signal(),
        snapshot: { ...snapshot, style } };
      await expect(runCleanup({ ...common, rawText: 'send to Voxlom' }))
        .resolves.toMatchObject({ status: 'cleaned', finalText: 'Send to Voxloom.' });
      await expect(runCleanup({ ...common, rawText: 'Keep 5 items' }))
        .resolves.toMatchObject({
          status: 'fallback', reason: 'invalid-output', finalText: 'Keep 5 items',
        });
    },
  );

  it('falls back once when output is invalid', async () => {
    const engine = {
      cancel: vi.fn(),
      run: vi.fn().mockResolvedValue('<think>rewriting</think>'),
    };
    await expect(runCleanup({
      engine,
      rawText: 'Keep 10.',
      requestId: 'r1',
      signal: signal(),
      snapshot,
    })).resolves.toEqual({
      finalText: 'Keep 10.',
      reason: 'invalid-output',
      status: 'fallback',
    });
  });

  it('cancels and ignores late output after timeout', async () => {
    const engine = {
      cancel: vi.fn().mockResolvedValue(undefined),
      run: vi.fn(() => new Promise<string>(() => undefined)),
    };
    const outcome = await runCleanup({
      engine,
      rawText: 'Keep this.',
      requestId: 'r-timeout',
      signal: signal(),
      snapshot,
      timeoutMs: 1,
    });
    expect(outcome).toMatchObject({
      finalText: 'Keep this.',
      reason: 'timeout',
    });
    expect(engine.cancel).toHaveBeenCalledWith('r-timeout');
  });

  it('preserves structured native context-overflow reasons', async () => {
    const engine = {
      cancel: vi.fn(),
      run: vi.fn().mockRejectedValue(
        new CleanupEngineError('context-overflow', 'context is full'),
      ),
    };
    await expect(runCleanup({
      engine,
      rawText: 'Keep this.',
      requestId: 'r-overflow',
      signal: signal(),
      snapshot,
    })).resolves.toEqual({
      finalText: 'Keep this.',
      reason: 'context-overflow',
      status: 'fallback',
    });
  });

  it('does not fall back when cancellation races worker failure', async () => {
    let abort: (() => void) | null = null;
    let aborted = false;
    let rejectInference: ((error: Error) => void) | null = null;
    const engine = {
      cancel: vi.fn().mockRejectedValue(new Error('already reaped')),
      run: vi.fn(() => new Promise<string>((_resolve, reject) => {
        rejectInference = reject;
      })),
    };
    const outcome = runCleanup({
      engine,
      rawText: 'Do not deliver this.',
      requestId: 'r-cancel',
      signal: {
        get aborted() { return aborted; },
        onAbort: (callback) => { abort = callback; },
      },
      snapshot,
    });
    aborted = true;
    (abort as unknown as () => void)();
    (rejectInference as unknown as (error: Error) => void)(
      new Error('worker exited'),
    );

    await expect(outcome).resolves.toEqual({
      reason: 'cancelled',
      status: 'cancelled',
    });
    expect(engine.cancel).toHaveBeenCalledWith('r-cancel');
  });
});
