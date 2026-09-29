import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  createTauriCleanupEngine,
  createTauriCleanupModelStore,
} from '../../../src/services/cleanup/tauriAdapter';

beforeEach(() => invoke.mockReset());

describe('Tauri cleanup adapters', () => {
  it('have no construction side effects', () => {
    createTauriCleanupEngine();
    createTauriCleanupModelStore();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('uses explicit requests and native-owned model import', async () => {
    invoke.mockResolvedValueOnce('Cleaned.');
    const engine = createTauriCleanupEngine();
    const request = {
      dictionary: [],
      modelId: 'qwen3-0.6b-q4-k-m',
      prompt: 'prompt',
      rawText: 'raw',
      requestId: 'r1',
      style: 'formal' as const,
    };
    await expect(engine.run(request)).resolves.toBe('Cleaned.');
    expect(invoke).toHaveBeenCalledWith('cleanup_run', { request });

    invoke.mockResolvedValueOnce({ available: true });
    await createTauriCleanupModelStore().importModel();
    expect(invoke).toHaveBeenLastCalledWith(
      'cleanup_pick_and_import_model',
    );
  });

  it('acquires and releases a request-scoped native model lease', async () => {
    invoke.mockResolvedValue(undefined);
    const engine = createTauriCleanupEngine();
    await engine.acquire?.('r-lease', 'qwen3-0.6b-q4-k-m');
    expect(invoke).toHaveBeenCalledWith('cleanup_acquire', {
      modelId: 'qwen3-0.6b-q4-k-m',
      requestId: 'r-lease',
    });
    await engine.release?.('r-lease');
    expect(invoke).toHaveBeenLastCalledWith('cleanup_release', {
      requestId: 'r-lease',
    });
  });

  it('maps structured native failures without parsing messages', async () => {
    invoke.mockRejectedValueOnce({
      code: 'context-overflow',
      message: 'prompt does not fit',
    });
    const engine = createTauriCleanupEngine();
    await expect(engine.run({
      dictionary: [],
      modelId: 'qwen3-0.6b-q4-k-m',
      prompt: 'prompt',
      rawText: 'raw',
      requestId: 'r-overflow',
      style: 'formal',
    })).rejects.toMatchObject({
      code: 'context-overflow',
      message: 'prompt does not fit',
    });
  });
});
