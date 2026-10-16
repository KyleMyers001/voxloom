/** BUS-91: Escape-cancel follow-ups on the shared dogfood hook. */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptureState } from '../../../src/services/capture/types';
import type { UseCaptureStateResult } from '../../../src/services/capture/useCaptureState';
import * as cancelScopeModule from '../../../src/services/shortcut/cancelScope';
import { createMockSttModelStore } from '../../../src/services/stt/mockStt';
import { useDogfoodCapture } from '../../../src/services/stt/useDogfoodCapture';

function stubCapture(state: CaptureState = { kind: 'idle' }): UseCaptureStateResult {
  return {
    cancelActiveCapture: vi.fn(), captureReady: true, captureState: state,
    deviceListError: null, devices: [], devicesLoading: false, permissionStatus: 'authorized',
    prepareDeviceChange: vi.fn().mockResolvedValue(true),
    refreshDevices: vi.fn().mockResolvedValue(undefined), requestMicPermission: vi.fn(),
    runMicTest: vi.fn(), startFullCaptureSession: vi.fn().mockResolvedValue('started'),
    stopFullCapture: vi.fn(), stopMicTest: vi.fn(),
    waitForCaptureRelease: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeScope() {
  return { dispose: vi.fn().mockResolvedValue(undefined), finish: vi.fn().mockResolvedValue(true) };
}

async function setup(capture = stubCapture(), extra: { onErrorToast?: (m: string) => void } = {}) {
  const store = createMockSttModelStore();
  await store.download('whisper-tiny.en');
  const toast = vi.fn();
  const hook = renderHook(() => useDogfoodCapture({
    captureApi: capture, clipboard: { copy: vi.fn() }, createModelStore: () => store,
    modelId: 'whisper-tiny.en', onToast: toast, ...extra,
  }));
  return { ...hook, capture, toast };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('Escape-cancel follow-ups (BUS-91)', () => {
  it('hints once per app run when arming fails, keeps dictating, and re-arms next session', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scope = fakeScope();
    const arm = vi.spyOn(cancelScopeModule, 'beginCancelScope')
      .mockRejectedValueOnce({ code: 'cancel-ax-untrusted', message: 'full diagnostic' })
      .mockResolvedValueOnce(scope)
      .mockRejectedValueOnce({ code: 'cancel-tap-create-failed', message: 'second' });
    const { result, toast } = await setup();

    await act(async () => { await result.current.start(); });
    expect(result.current.phase).toBe('recording');
    expect(result.current.scopeReady).toBe(false);
    expect(result.current.cancelUnavailable)
      .toEqual({ code: 'cancel-ax-untrusted', details: 'full diagnostic' });
    const hints = () => toast.mock.calls.filter(([m]) => /Escape-cancel is off/.test(m));
    expect(hints()).toHaveLength(1);

    act(() => result.current.cancel());
    await act(async () => { await result.current.start(); });
    expect(arm).toHaveBeenCalledTimes(2);
    expect(result.current.scopeReady).toBe(true);

    act(() => result.current.cancel());
    expect(scope.dispose).toHaveBeenCalled();
    await act(async () => { await result.current.start(); });
    expect(result.current.phase).toBe('recording');
    expect(hints()).toHaveLength(1);
    expect(result.current.cancelUnavailable?.code).toBe('cancel-ax-untrusted');
  });

  it('disposes a scope that armed after its session was superseded', async () => {
    const stale = fakeScope();
    let armStale!: () => void;
    vi.spyOn(cancelScopeModule, 'beginCancelScope')
      .mockImplementationOnce(() => new Promise((resolve) => { armStale = () => resolve(stale); }))
      .mockResolvedValueOnce(fakeScope());
    const { result } = await setup();
    let first!: Promise<void>;
    act(() => { first = result.current.start(); });
    await waitFor(() => expect(armStale).toBeTypeOf('function'));
    act(() => result.current.cancel());
    await act(async () => { armStale(); await first; });
    expect(stale.dispose).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe('cancelled');
  });

  it('restart after cancel waits for owner release instead of reporting busy', async () => {
    vi.spyOn(cancelScopeModule, 'beginCancelScope').mockResolvedValue(fakeScope());
    let release!: () => void;
    const capture = stubCapture();
    capture.waitForCaptureRelease = vi.fn(() => new Promise<void>((done) => { release = done; }));
    const { result } = await setup(capture);
    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(capture.waitForCaptureRelease).toHaveBeenCalledOnce());
    expect(capture.startFullCaptureSession).not.toHaveBeenCalled();
    await act(async () => { release(); await start; });
    expect(capture.startFullCaptureSession).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe('recording');
  });

  it('does not start capture when cancelled while waiting for release', async () => {
    vi.spyOn(cancelScopeModule, 'beginCancelScope').mockResolvedValue(fakeScope());
    let release!: () => void;
    const capture = stubCapture();
    capture.waitForCaptureRelease = vi.fn(() => new Promise<void>((done) => { release = done; }));
    const { result } = await setup(capture);
    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(capture.waitForCaptureRelease).toHaveBeenCalledOnce());
    act(() => result.current.cancel());
    await act(async () => { release(); await start; });
    expect(capture.startFullCaptureSession).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('cancelled');
  });

  it('routes start failures to the error toast', async () => {
    vi.spyOn(cancelScopeModule, 'beginCancelScope').mockResolvedValue(fakeScope());
    const capture = stubCapture();
    capture.startFullCaptureSession = vi.fn().mockResolvedValue('busy');
    const onErrorToast = vi.fn();
    const { result, toast } = await setup(capture, { onErrorToast });
    await act(async () => { await result.current.start(); });
    expect(result.current.phase).toBe('error');
    expect(onErrorToast).toHaveBeenCalledExactlyOnceWith(
      'A capture session is already active. Wait for it to finish.');
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('already active'));
  });
});
