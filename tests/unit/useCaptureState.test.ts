import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cancelCapture: vi.fn(),
  createCaptureRequestId: vi.fn(),
  getCaptureStatus: vi.fn(),
  isTauriEnv: vi.fn(),
  listDevices: vi.fn(),
  onCaptureEvent: vi.fn(),
  queryPermission: vi.fn(),
  requestPermission: vi.fn(),
  startFullCapture: vi.fn(),
  startMicTest: vi.fn(),
  stopCapture: vi.fn(),
}));

vi.unmock('../../src/services/capture/useCaptureState');
vi.mock('../../src/services/capture/captureService', () => mocks);

import type { CaptureEvent } from
  '../../src/services/capture/types';
import { useCaptureState } from
  '../../src/services/capture/useCaptureState';

function deferred<T>() {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    reject = onReject;
    resolve = onResolve;
  });
  return { promise, reject, resolve };
}

describe('useCaptureState request ownership', () => {
  let handler: ((event: CaptureEvent) => void) | null;
  let nextId: number;
  let unlisten: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = null;
    nextId = 1;
    unlisten = vi.fn();
    mocks.cancelCapture.mockResolvedValue(true);
    mocks.createCaptureRequestId.mockImplementation(
      () => `request-${nextId++}`,
    );
    mocks.getCaptureStatus.mockResolvedValue(null);
    mocks.isTauriEnv.mockReturnValue(true);
    mocks.listDevices.mockResolvedValue([]);
    mocks.onCaptureEvent.mockImplementation(async (callback) => {
      handler = callback;
      return unlisten;
    });
    mocks.queryPermission.mockResolvedValue(undefined);
    mocks.requestPermission.mockResolvedValue(undefined);
    mocks.startMicTest.mockImplementation(async (requestId) => ({
      generation: 7,
      mode: 'test',
      request_id: requestId,
    }));
  });

  it('waits for listener readiness before starting', async () => {
    const listener = deferred<() => void>();
    mocks.onCaptureEvent.mockReturnValue(listener.promise);
    const { result } = renderHook(() => useCaptureState());

    let run!: Promise<void>;
    act(() => { run = result.current.runMicTest(); });
    expect(result.current.captureState).toMatchObject({
      kind: 'test-running',
      request_id: 'request-1',
    });
    expect(mocks.startMicTest).not.toHaveBeenCalled();

    listener.resolve(unlisten as () => void);
    await act(async () => { await run; });
    expect(mocks.startMicTest).toHaveBeenCalledWith(
      'request-1',
      undefined,
    );
  });

  it('blocks device switches until native ownership is known',
    async () => {
      const status = deferred<null>();
      mocks.getCaptureStatus.mockReturnValue(status.promise);
      const { result } = renderHook(() => useCaptureState());
      await act(async () => {});

      expect(result.current.captureReady).toBe(false);
      await expect(result.current.prepareDeviceChange()).resolves.toBe(false);

      status.resolve(null);
      await waitFor(() => expect(result.current.captureReady).toBe(true));
      await expect(result.current.prepareDeviceChange()).resolves.toBe(true);
    });

  it('keeps device changes locked when native status fails', async () => {
    mocks.getCaptureStatus.mockRejectedValue(new Error('status failed'));
    const { result } = renderHook(() => useCaptureState());

    await waitFor(() => {
      expect(result.current.captureState.kind).toBe('error');
    });
    expect(result.current.captureReady).toBe(false);
    await expect(result.current.prepareDeviceChange()).resolves.toBe(false);
  });

  it('rejects status for a session that terminated before status resolves',
    async () => {
      const status = deferred<{
        generation: number;
        mode: 'test';
        request_id: string;
      }>();
      mocks.getCaptureStatus.mockReturnValue(status.promise);
      const { result } = renderHook(() => useCaptureState());
      await waitFor(() => expect(handler).not.toBeNull());

      act(() => handler?.({
        generation: 12,
        kind: 'capture-stopped',
        request_id: 'native-owner',
      }));
      status.resolve({
        generation: 12,
        mode: 'test',
        request_id: 'native-owner',
      });

      await waitFor(() => expect(result.current.captureReady).toBe(true));
      expect(result.current.captureState).toEqual({ kind: 'idle' });
      expect(mocks.cancelCapture).not.toHaveBeenCalled();
    });

  it('does not let an unrelated terminal suppress valid native status',
    async () => {
      const status = deferred<{
        generation: number;
        mode: 'test';
        request_id: string;
      }>();
      mocks.getCaptureStatus.mockReturnValue(status.promise);
      const { result } = renderHook(() => useCaptureState());
      await waitFor(() => expect(handler).not.toBeNull());

      act(() => handler?.({
        generation: 4,
        kind: 'capture-cancelled',
        request_id: 'unrelated',
      }));
      status.resolve({
        generation: 5,
        mode: 'test',
        request_id: 'native-owner',
      });

      await waitFor(() => expect(result.current.captureState).toMatchObject({
        generation: 5,
        kind: 'test-running',
        request_id: 'native-owner',
      }));
    });

  it('fails status adoption closed when terminal cache reaches its bound',
    async () => {
      const status = deferred<{
        generation: number;
        mode: 'test';
        request_id: string;
      }>();
      mocks.getCaptureStatus.mockReturnValue(status.promise);
      const { result } = renderHook(() => useCaptureState());
      await waitFor(() => expect(handler).not.toBeNull());

      for (let generation = 1; generation <= 33; generation += 1) {
        act(() => handler?.({
          generation,
          kind: 'capture-stopped',
          request_id: `ended-${generation}`,
        }));
      }
      status.resolve({
        generation: 33,
        mode: 'test',
        request_id: 'ended-33',
      });

      await waitFor(() => {
        expect(result.current.captureState.kind).toBe('error');
      });
      expect(result.current.captureReady).toBe(false);
      await expect(result.current.prepareDeviceChange())
        .resolves.toBe(false);
    });

  it('blocks a duplicate start before invoking IPC', async () => {
    const start = deferred<{
      generation: number;
      mode: 'test';
      request_id: string;
    }>();
    mocks.startMicTest.mockReturnValue(start.promise);
    const { result } = renderHook(() => useCaptureState());
    await act(async () => {});

    act(() => {
      void result.current.runMicTest();
      void result.current.runMicTest();
    });
    await waitFor(() => expect(mocks.startMicTest).toHaveBeenCalledOnce());
    start.resolve({
      generation: 3,
      mode: 'test',
      request_id: 'request-2',
    });
  });

  it('does not resurrect state after terminal-before-response', async () => {
    const start = deferred<{
      generation: number;
      mode: 'test';
      request_id: string;
    }>();
    mocks.startMicTest.mockReturnValue(start.promise);
    const { result } = renderHook(() => useCaptureState());
    await act(async () => {});
    act(() => { void result.current.runMicTest(); });
    await waitFor(() => expect(mocks.startMicTest).toHaveBeenCalledOnce());

    const requestId = mocks.startMicTest.mock.calls[0][0];
    const metadata = {
      detected_activity: true,
      duration_secs: 1,
      frame_count: 16_000,
      peak_level: 0.5,
    };
    act(() => handler?.({
      generation: 4,
      kind: 'test-complete',
      metadata,
      request_id: requestId,
    }));
    expect(result.current.captureState.kind).toBe('test-complete');

    start.resolve({
      generation: 4,
      mode: 'test',
      request_id: requestId,
    });
    await act(async () => {});
    expect(result.current.captureState.kind).toBe('test-complete');
  });

  it('ignores a mismatched generation for the owned request', async () => {
    const { result } = renderHook(() => useCaptureState());
    await act(async () => {});
    await act(async () => { await result.current.runMicTest(); });
    expect(result.current.captureState).toMatchObject({
      generation: 7,
      kind: 'test-running',
    });

    const requestId = mocks.startMicTest.mock.calls[0][0];
    act(() => handler?.({
      category: 'capture-unavailable',
      generation: 6,
      kind: 'capture-error',
      message: 'stale',
      request_id: requestId,
    }));
    expect(result.current.captureState.kind).toBe('test-running');
  });

  it('cancels a pending response by request ID without resurrection',
    async () => {
      const start = deferred<{
        generation: number;
        mode: 'test';
        request_id: string;
      }>();
      mocks.startMicTest.mockReturnValue(start.promise);
      const { result } = renderHook(() => useCaptureState());
      await act(async () => {});
      act(() => { void result.current.runMicTest(); });
      await waitFor(() => expect(mocks.startMicTest).toHaveBeenCalledOnce());
      const requestId = mocks.startMicTest.mock.calls[0][0];

      act(() => result.current.stopMicTest());
      expect(mocks.cancelCapture).toHaveBeenCalledWith(requestId);
      start.resolve({
        generation: 8,
        mode: 'test',
        request_id: requestId,
      });
      await act(async () => {});
      expect(result.current.captureState.kind).toBe('idle');
    });

  it('fails closed when listener registration rejects', async () => {
    mocks.onCaptureEvent.mockRejectedValue(new Error('listener denied'));
    const { result } = renderHook(() => useCaptureState());
    await waitFor(() => {
      expect(result.current.captureState.kind).toBe('error');
    });

    await act(async () => { await result.current.runMicTest(); });
    expect(mocks.startMicTest).not.toHaveBeenCalled();
    expect(result.current.captureState).toMatchObject({
      category: 'capture-unavailable',
      kind: 'error',
    });
  });

  it('creates a fresh listener gate after a failed mount', async () => {
    mocks.onCaptureEvent.mockRejectedValueOnce(
      new Error('listener denied'),
    );
    const first = renderHook(() => useCaptureState());
    await waitFor(() => {
      expect(first.result.current.captureState.kind).toBe('error');
    });
    first.unmount();

    mocks.onCaptureEvent.mockImplementation(async (callback) => {
      handler = callback;
      return unlisten;
    });
    const second = renderHook(() => useCaptureState());
    await act(async () => {});
    await act(async () => {
      await second.result.current.runMicTest();
    });
    expect(mocks.startMicTest).toHaveBeenCalledOnce();
    expect(second.result.current.captureState.kind)
      .toBe('test-running');
  });

  it('normalizes a rejected busy start', async () => {
    mocks.startMicTest.mockRejectedValue(new Error('busy'));
    const { result } = renderHook(() => useCaptureState());
    await act(async () => {});
    await act(async () => { await result.current.runMicTest(); });
    expect(result.current.captureState).toEqual({
      category: 'busy',
      kind: 'error',
      message: 'A capture session is already active.',
    });
  });

  it('adopts exact native status on remount and cancels its owner',
    async () => {
      mocks.getCaptureStatus.mockResolvedValue({
        generation: 12,
        mode: 'test',
        request_id: 'native-owner',
      });
      const { result, unmount } = renderHook(() => useCaptureState());
      await waitFor(() => {
        expect(result.current.captureState).toMatchObject({
          generation: 12,
          kind: 'test-running',
          request_id: 'native-owner',
        });
      });
      unmount();
      expect(mocks.cancelCapture).toHaveBeenCalledWith('native-owner');
      await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
    });

  it('unmount before subscription resolves cancels only its request',
    async () => {
      const listener = deferred<() => void>();
      mocks.onCaptureEvent.mockReturnValue(listener.promise);
      const first = renderHook(() => useCaptureState());
      act(() => { void first.result.current.runMicTest(); });
      first.unmount();
      expect(mocks.cancelCapture).toHaveBeenCalledWith('request-1');
      expect(mocks.startMicTest).not.toHaveBeenCalled();

      listener.resolve(unlisten as () => void);
      await act(async () => {});
      expect(unlisten).toHaveBeenCalledOnce();
      expect(mocks.cancelCapture).not.toHaveBeenCalledWith('request-2');
    });

  it('waits for the matching terminal before allowing a device switch',
    async () => {
      const { result } = renderHook(() => useCaptureState());
      await act(async () => {});
      await act(async () => { await result.current.runMicTest('input-1'); });
      const requestId = mocks.startMicTest.mock.calls[0][0];

      let switchResult: boolean | undefined;
      act(() => {
        void result.current.prepareDeviceChange().then((ready) => {
          switchResult = ready;
        });
      });
      await waitFor(() => {
        expect(mocks.cancelCapture).toHaveBeenCalledWith(requestId);
      });
      act(() => handler?.({
        generation: 99,
        kind: 'capture-cancelled',
        request_id: 'unrelated-request',
      }));
      await act(async () => {});
      expect(switchResult).toBeUndefined();

      act(() => handler?.({
        generation: 7,
        kind: 'capture-cancelled',
        request_id: requestId,
      }));
      await waitFor(() => expect(switchResult).toBe(true));
      expect(result.current.captureState.kind).toBe('idle');
    });

  it('coalesces rapid switches and only the latest may commit', async () => {
    const { result } = renderHook(() => useCaptureState());
    await act(async () => {});
    await act(async () => { await result.current.runMicTest('input-1'); });
    const requestId = mocks.startMicTest.mock.calls[0][0];

    let first: boolean | undefined;
    let second: boolean | undefined;
    act(() => {
      void result.current.prepareDeviceChange().then((ready) => {
        first = ready;
      });
      void result.current.prepareDeviceChange().then((ready) => {
        second = ready;
      });
    });
    await waitFor(() => expect(mocks.cancelCapture).toHaveBeenCalledOnce());
    act(() => handler?.({
      generation: 7,
      kind: 'capture-cancelled',
      request_id: requestId,
    }));
    await waitFor(() => expect(second).toBe(true));
    expect(first).toBe(false);
  });

  it('unmount resolves a pending switch without changing ownership',
    async () => {
      const { result, unmount } = renderHook(() => useCaptureState());
      await act(async () => {});
      await act(async () => { await result.current.runMicTest('input-1'); });
      const requestId = mocks.startMicTest.mock.calls[0][0];
      let switchResult: boolean | undefined;
      act(() => {
        void result.current.prepareDeviceChange().then((ready) => {
          switchResult = ready;
        });
      });
      await waitFor(() => {
        expect(mocks.cancelCapture).toHaveBeenCalledWith(requestId);
      });

      unmount();
      await waitFor(() => expect(switchResult).toBe(false));
      expect(mocks.cancelCapture).toHaveBeenCalledOnce();
      expect(mocks.cancelCapture).toHaveBeenCalledWith(requestId);
    });

  it('fails a switch closed when no terminal arrives', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useCaptureState());
      await act(async () => {});
      await act(async () => { await result.current.runMicTest('input-1'); });
      let switchResult: boolean | undefined;
      act(() => {
        void result.current.prepareDeviceChange().then((ready) => {
          switchResult = ready;
        });
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(switchResult).toBe(false);
      expect(result.current.captureState).toMatchObject({
        category: 'capture-unavailable',
        kind: 'error',
      });
      expect(mocks.startMicTest).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores stale refresh results and retains devices on list error',
    async () => {
      const { result } = renderHook(() => useCaptureState());
      await act(async () => {});
      const first = deferred<Array<{
        available: boolean;
        id: string;
        label: string;
      }>>();
      const second = deferred<Array<{
        available: boolean;
        id: string;
        label: string;
      }>>();
      mocks.listDevices
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);

      act(() => {
        void result.current.refreshDevices();
        void result.current.refreshDevices();
      });
      second.resolve([
        { available: true, id: 'input-2', label: 'Newest' },
      ]);
      await waitFor(() => expect(result.current.devices[0]?.id)
        .toBe('input-2'));
      first.resolve([
        { available: true, id: 'input-1', label: 'Stale' },
      ]);
      await act(async () => {});
      expect(result.current.devices[0]?.id).toBe('input-2');

      mocks.listDevices.mockRejectedValueOnce(new Error('device list failed'));
      await act(async () => { await result.current.refreshDevices(); });
      expect(result.current.devices[0]?.id).toBe('input-2');
      expect(result.current.deviceListError).toBe(
        'Microphone capture is not available.',
      );
    });
});


describe('useCaptureState full capture dogfood wiring', () => {
  let handler: ((event: CaptureEvent) => void) | null;
  let nextId: number;
  let unlisten: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = null;
    nextId = 1;
    unlisten = vi.fn();
    mocks.cancelCapture.mockResolvedValue(true);
    mocks.createCaptureRequestId.mockImplementation(
      () => `request-${nextId++}`,
    );
    mocks.getCaptureStatus.mockResolvedValue(null);
    mocks.isTauriEnv.mockReturnValue(true);
    mocks.listDevices.mockResolvedValue([]);
    mocks.onCaptureEvent.mockImplementation(async (callback) => {
      handler = callback;
      return unlisten;
    });
    mocks.queryPermission.mockResolvedValue(undefined);
    mocks.requestPermission.mockResolvedValue(undefined);
    mocks.startFullCapture.mockImplementation(async (requestId) => ({
      generation: 3,
      mode: 'full',
      request_id: requestId,
    }));
    mocks.startMicTest.mockImplementation(async (requestId) => ({
      generation: 7,
      mode: 'test',
      request_id: requestId,
    }));
    mocks.stopCapture.mockResolvedValue(undefined);
  });

  it('full capture stop exposes audio on stopped state', async () => {
    const { result } = renderHook(() => useCaptureState());
    await waitFor(() => expect(handler).not.toBeNull());

    await act(async () => {
      await result.current.startFullCaptureSession();
    });
    expect(mocks.startFullCapture).toHaveBeenCalled();
    const requestId = mocks.startFullCapture.mock.calls[0][0] as string;

    act(() => handler?.({
      audio: {
        duration_ms: 500,
        id: 'pcm-ui-1',
        sample_rate_hz: 16_000,
      },
      generation: 3,
      kind: 'capture-stopped',
      request_id: requestId,
    }));

    expect(result.current.captureState).toEqual({
      audio: {
        duration_ms: 500,
        id: 'pcm-ui-1',
        sample_rate_hz: 16_000,
      },
      kind: 'stopped',
    });
  });

  it('rejects a second start while the previous owner is still active', async () => {
    const pending = deferred<{ generation: number; mode: 'full'; request_id: string }>();
    mocks.startFullCapture.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useCaptureState());
    await waitFor(() => expect(handler).not.toBeNull());

    let first!: Promise<unknown>;
    act(() => { first = result.current.startFullCaptureSession(); });
    await waitFor(() => expect(mocks.startFullCapture).toHaveBeenCalledOnce());
    await expect(result.current.startFullCaptureSession()).resolves.toBe('busy');
    expect(mocks.startFullCapture).toHaveBeenCalledOnce();

    pending.resolve({
      generation: 3,
      mode: 'full',
      request_id: mocks.startFullCapture.mock.calls[0][0] as string,
    });
    await act(async () => { expect(await first).toBe('started'); });
  });

  it('reports listener failure instead of claiming a recording', async () => {
    mocks.onCaptureEvent.mockRejectedValue(new Error('listener unavailable'));
    const { result } = renderHook(() => useCaptureState());
    await waitFor(() => expect(result.current.captureState.kind).toBe('error'));
    await act(async () => {
      expect(await result.current.startFullCaptureSession()).toBe('error');
    });
    expect(mocks.startFullCapture).not.toHaveBeenCalled();
  });

  it('reports native start failure instead of claiming capture', async () => {
    mocks.startFullCapture.mockRejectedValue(new Error('permission-denied'));
    const { result } = renderHook(() => useCaptureState());
    await waitFor(() => expect(handler).not.toBeNull());
    await act(async () => {
      expect(await result.current.startFullCaptureSession()).toBe('error');
    });
    expect(result.current.captureState).toMatchObject({ kind: 'error' });
  });

  it('does not resurrect capture after a terminal beats the start reply', async () => {
    const pending = deferred<{ generation: number; mode: 'full'; request_id: string }>();
    mocks.startFullCapture.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useCaptureState());
    await waitFor(() => expect(handler).not.toBeNull());

    let start!: Promise<unknown>;
    act(() => { start = result.current.startFullCaptureSession(); });
    await waitFor(() => expect(mocks.startFullCapture).toHaveBeenCalledOnce());
    const requestId = mocks.startFullCapture.mock.calls[0][0] as string;
    act(() => handler?.({
      generation: 3,
      kind: 'capture-cancelled',
      request_id: requestId,
    }));
    pending.resolve({ generation: 3, mode: 'full', request_id: requestId });
    await act(async () => { expect(await start).toBe('ended'); });
    expect(result.current.captureState).toEqual({ kind: 'cancelled' });
  });

  it('cancel does not deposit audio', async () => {
    const { result } = renderHook(() => useCaptureState());
    await waitFor(() => expect(handler).not.toBeNull());

    await act(async () => {
      await result.current.startFullCaptureSession();
    });
    const requestId = mocks.startFullCapture.mock.calls[0][0] as string;

    act(() => {
      result.current.cancelActiveCapture();
    });
    act(() => handler?.({
      generation: 3,
      kind: 'capture-cancelled',
      request_id: requestId,
    }));
    expect(result.current.captureState).toEqual({ kind: 'cancelled' });
    expect(mocks.stopCapture).not.toHaveBeenCalled();
  });
});
