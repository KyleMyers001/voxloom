import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  createTauriCleanupEngine,
  createTauriCleanupModelStore,
} from '../../../src/services/cleanup/tauriAdapter';

const request = {
  dictionary: [],
  modelId: 'qwen3-0.6b-q4-k-m',
  prompt: 'prompt',
  rawText: 'raw',
  requestId: 'r1',
  style: 'formal' as const,
};

beforeEach(() => {
  invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'cleanup_session_open') return 'native-owner-1';
    if (command === 'cleanup_run') return 'Cleaned.';
    return undefined;
  });
});

describe('Tauri cleanup adapters', () => {
  it('have no construction or unused teardown side effects', async () => {
    const engine = createTauriCleanupEngine();
    createTauriCleanupModelStore();
    await engine.release?.('unused');
    await engine.cancel('unused');
    await engine.dispose?.();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('uses native-issued ownership for requests and native-owned import', async () => {
    const engine = createTauriCleanupEngine();
    await expect(engine.run(request)).resolves.toBe('Cleaned.');
    expect(invoke).toHaveBeenCalledWith('cleanup_session_open');
    expect(invoke).toHaveBeenCalledWith('cleanup_run', {
      request, sessionId: 'native-owner-1',
    });
    await createTauriCleanupModelStore().importModel();
    expect(invoke).toHaveBeenLastCalledWith('cleanup_pick_and_import_model');
  });

  it('shares one session across acquire, cancel, release and repeated disposal', async () => {
    const engine = createTauriCleanupEngine();
    await engine.acquire?.('r-lease', request.modelId);
    expect(invoke).toHaveBeenCalledWith('cleanup_acquire', {
      modelId: request.modelId, requestId: 'r-lease', sessionId: 'native-owner-1',
    });
    await engine.cancel('r-lease');
    expect(invoke).toHaveBeenLastCalledWith('cleanup_cancel', {
      requestId: 'r-lease', sessionId: 'native-owner-1',
    });
    await engine.release?.('r-lease');
    expect(invoke).toHaveBeenLastCalledWith('cleanup_release', {
      requestId: 'r-lease', sessionId: 'native-owner-1',
    });
    await engine.dispose?.();
    await engine.dispose?.();
    expect(invoke).toHaveBeenLastCalledWith('cleanup_session_dispose', {
      sessionId: 'native-owner-1',
    });
    expect(invoke.mock.calls.filter(([command]) => command === 'cleanup_session_open')).toHaveLength(1);
    expect(invoke.mock.calls.filter(([command]) => command === 'cleanup_session_dispose')).toHaveLength(1);
    await expect(engine.run(request)).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('retires a handshake that finishes after disposal without acquiring', async () => {
    let opened!: (id: string) => void;
    invoke.mockImplementationOnce(() => new Promise<string>((resolve) => { opened = resolve; }));
    const engine = createTauriCleanupEngine();
    const acquiring = engine.acquire?.('r1', request.modelId);
    const rejected = expect(acquiring).rejects.toMatchObject({ code: 'cancelled' });
    const disposing = engine.dispose?.();
    opened('late-owner');
    await rejected;
    await disposing;
    expect(invoke).not.toHaveBeenCalledWith('cleanup_acquire', expect.anything());
    expect(invoke).toHaveBeenLastCalledWith('cleanup_session_dispose', { sessionId: 'late-owner' });
  });

  it('settles a pending acquire before releasing so IPC reordering cannot leak it', async () => {
    let finish!: () => void;
    invoke.mockImplementation(async (command: string) => {
      if (command === 'cleanup_session_open') return 'native-owner-1';
      if (command === 'cleanup_acquire') return new Promise<void>((resolve) => { finish = resolve; });
    });
    const engine = createTauriCleanupEngine();
    const acquiring = engine.acquire?.('r1', request.modelId);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const releasing = engine.release?.('r1');
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalledWith('cleanup_release', expect.anything());
    finish();
    await acquiring;
    await releasing;
    expect(invoke).toHaveBeenLastCalledWith('cleanup_release', {
      requestId: 'r1', sessionId: 'native-owner-1',
    });
  });

  it('does not open a replacement session when settling a failed handshake', async () => {
    invoke.mockRejectedValueOnce({ code: 'runtime-error', message: 'session unavailable' });
    const engine = createTauriCleanupEngine();
    const acquiring = engine.acquire?.('r1', request.modelId);
    const failed = expect(acquiring).rejects.toMatchObject({ code: 'runtime-error' });
    const releasing = engine.release?.('r1');
    await failed;
    await releasing;
    expect(invoke).toHaveBeenCalledExactlyOnceWith('cleanup_session_open');
  });

  it('does not reuse a disposed owner after remount', async () => {
    const first = createTauriCleanupEngine();
    await first.acquire?.('same-id', request.modelId);
    await first.dispose?.();
    invoke.mockImplementation(async (command: string) => {
      if (command === 'cleanup_session_open') return 'native-owner-2';
    });
    const second = createTauriCleanupEngine();
    await second.acquire?.('same-id', request.modelId);
    await first.release?.('same-id');
    expect(invoke).toHaveBeenLastCalledWith('cleanup_acquire', {
      modelId: request.modelId, requestId: 'same-id', sessionId: 'native-owner-2',
    });
  });

  it.each(['unknown-future-code', 'constructor', ['timeout'], 4, null])(
    'maps unknown native codes to a safe runtime error: %j', async (code) => {
      invoke.mockRejectedValueOnce({ code, message: 'native diagnostic' });
      await expect(createTauriCleanupEngine().run(request)).rejects.toMatchObject({
        code: 'runtime-error', message: 'native diagnostic',
      });
    },
  );

  it('maps structured native failures without parsing messages', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'cleanup_session_open') return 'native-owner-1';
      throw { code: 'context-overflow', message: 'prompt does not fit' };
    });
    await expect(createTauriCleanupEngine().run(request)).rejects.toMatchObject({
      code: 'context-overflow', message: 'prompt does not fit',
    });
  });
});
