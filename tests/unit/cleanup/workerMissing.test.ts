// BUS-135: a build without the cleanup worker keeps cleanup on but never
// runs it. The native lease refuses with `worker-missing` before hashing the
// model; the dictation delivers the raw text and History says "unavailable".
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  Channel: class { onmessage: (value: unknown) => void = () => {}; },
}));

import { cleanupLabel } from '../../../src/features/history/cleanupProvenance';
import { createTauriCleanupEngine } from '../../../src/services/cleanup/tauriAdapter';
import { CLEANUP_MODEL_ID } from '../../../src/services/cleanup/types';
import { prepareDogfoodCleanup } from '../../../src/services/stt/dogfoodCleanup';

const NO_WORKER = {
  code: 'worker-missing',
  message: 'cleanup worker is not installed or not executable in this build',
};

beforeEach(() => {
  invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'cleanup_session_open') return 'owner-1';
    if (command === 'cleanup_acquire') throw NO_WORKER;
    return undefined;
  });
});

describe('cleanup without a worker (BUS-135)', () => {
  it('keeps the native reason instead of a generic runtime error', async () => {
    await expect(createTauriCleanupEngine().acquire?.('r1', CLEANUP_MODEL_ID))
      .rejects.toMatchObject({ code: 'worker-missing' });
  });

  it('delivers the raw text, never runs, and History says unavailable', async () => {
    const settings = {
      active: true, dictionary: [], modelId: CLEANUP_MODEL_ID, style: 'formal' as const,
    };
    const cleanup = prepareDogfoodCleanup({
      controller: new AbortController(),
      engine: createTauriCleanupEngine,
      onStart: () => {},
      requestId: 'r1',
      settings,
      userCancelled: () => false,
    });
    const outcome = await cleanup.stage?.('um send it');
    expect(outcome).toEqual({
      finalText: 'um send it', reason: 'worker-missing', status: 'fallback',
    });
    expect(invoke).not.toHaveBeenCalledWith('cleanup_run', expect.anything());
    const provenance = await cleanup.provenance(outcome);
    expect(provenance).toMatchObject({
      modelDigest: null, reason: 'worker-missing', status: 'fallback',
    });
    expect(cleanupLabel(provenance)).toBe('Original kept · cleanup unavailable');
    // The setting itself is never touched: a worker build resumes cleanup.
    expect(settings.active).toBe(true);
  });
});
