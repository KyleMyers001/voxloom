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
});
