import { describe, expect, it, vi } from 'vitest';
import { runCleanup } from '../../../src/services/cleanup/runCleanup';
import {
  CLEANUP_MODEL_ID, CLEANUP_MODEL_SHA256, CleanupEngineError,
  type CleanupAttempt, type CleanupRequest,
} from '../../../src/services/cleanup/types';

const attempt = { modelId: CLEANUP_MODEL_ID, modelDigest: CLEANUP_MODEL_SHA256 };
const snapshot = { dictionary: [], enabled: true, modelId: CLEANUP_MODEL_ID, style: 'formal' as const };
const input = () => ({
  rawText: 'raw', requestId: 'r', signal: { aborted: false, onAbort: vi.fn() }, snapshot,
});

describe('cleanup attempt evidence', () => {
  it.each(['context-overflow', 'model-missing', 'runtime-error', 'invalid-output', 'timeout'] as const)(
    'retains verified attempt for post-launch %s, not for preflight', async (code) => {
      for (const launched of [false, true]) {
        const outcome = await runCleanup({ ...input(), engine: {
          cancel: vi.fn(), run: vi.fn().mockRejectedValue(
            new CleanupEngineError(code, 'diagnostic', launched ? attempt : undefined),
          ),
        } });
        expect(outcome).toMatchObject({ reason: code, status: 'fallback', finalText: 'raw' });
        expect(outcome.attempt).toEqual(launched ? attempt : undefined);
      }
    },
  );

  it('announces launch once, only after the engine attests to it', async () => {
    const onStarted = vi.fn();
    const outcome = await runCleanup({ ...input(), onStarted, engine: {
      cancel: vi.fn(),
      run: async (_request: CleanupRequest, started?: (evidence: CleanupAttempt) => void) => {
        expect(onStarted).not.toHaveBeenCalled();
        started?.(attempt);
        started?.(attempt);
        expect(onStarted).toHaveBeenCalledOnce();
        return { attempt, text: 'Raw.' };
      },
    } });
    expect(outcome).toEqual({ attempt, finalText: 'Raw.', status: 'cleaned' });
  });

  it('keeps final evidence if launch notification was lost without a late phase flash', async () => {
    const onStarted = vi.fn();
    const outcome = await runCleanup({ ...input(), onStarted, engine: {
      cancel: vi.fn(), run: vi.fn().mockResolvedValue({ attempt, text: 'Raw.' }),
    } });
    expect(outcome.attempt).toEqual(attempt);
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('retains launch evidence when fidelity rejects the candidate', async () => {
    const outcome = await runCleanup({ ...input(), engine: {
      cancel: vi.fn(), run: vi.fn().mockResolvedValue({ attempt, text: 'Invented answer.' }),
    } });
    expect(outcome).toEqual({ attempt, finalText: 'raw', reason: 'invalid-output', status: 'fallback' });
  });

  it('settles a synchronous engine failure as raw fallback', async () => {
    await expect(runCleanup({ ...input(), engine: {
      cancel: vi.fn(), run: () => { throw new Error('sync failure'); },
    } })).resolves.toEqual({ finalText: 'raw', reason: 'runtime-error', status: 'fallback' });
  });

  it.each(['timeout', 'overflow'] as const)(
    'preserves cancellation while settling a %s fallback', async (kind) => {
      let settled!: () => void;
      const signal = { aborted: false, onAbort: vi.fn() };
      const cancel = vi.fn(() => new Promise<void>((resolve) => { settled = resolve; }));
      const pending = runCleanup({ ...input(), signal, timeoutMs: 1,
        rawText: kind === 'overflow' ? 'x'.repeat(16_001) : 'raw',
        engine: { cancel, run: () => new Promise<string>(() => {}) },
      });
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      signal.aborted = true;
      settled();
      await expect(pending).resolves.toEqual({ reason: 'cancelled', status: 'cancelled' });
    },
  );

  it('preserves cancellation precedence over disabled or missing-model preflight', async () => {
    for (const enabled of [false, true]) {
      await expect(runCleanup({ ...input(), snapshot: { ...snapshot, enabled, modelId: null },
        signal: { aborted: true, onAbort: vi.fn() }, engine: { cancel: vi.fn(), run: vi.fn() },
      })).resolves.toEqual({ reason: 'cancelled', status: 'cancelled' });
    }
  });
});
