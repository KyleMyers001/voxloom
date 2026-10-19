/** BUS-91: which capture terminal events a dogfood session acts on. */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptureState } from '../../../src/services/capture/types';
import type { UseCaptureStateResult } from '../../../src/services/capture/useCaptureState';
import * as cancelScopeModule from '../../../src/services/shortcut/cancelScope';
import { createMockSttModelStore } from '../../../src/services/stt/mockStt';
import { useDogfoodCapture } from '../../../src/services/stt/useDogfoodCapture';

const EMPTY_STOP = 'Capture stopped without audio — nothing to transcribe.';
const emptyStop: CaptureState = { kind: 'stopped' };
const micLost: CaptureState = { category: 'busy', kind: 'error', message: 'mic lost' };

function stubCapture(): UseCaptureStateResult {
  return {
    cancelActiveCapture: vi.fn(), captureReady: true, captureState: { kind: 'idle' },
    deviceListError: null, devices: [], devicesLoading: false, permissionStatus: 'authorized',
    prepareDeviceChange: vi.fn().mockResolvedValue(true),
    refreshDevices: vi.fn().mockResolvedValue(undefined), requestMicPermission: vi.fn(),
    runMicTest: vi.fn(), startFullCaptureSession: vi.fn().mockResolvedValue('started'),
    stopFullCapture: vi.fn().mockResolvedValue(undefined), stopMicTest: vi.fn(),
    waitForCaptureRelease: vi.fn().mockResolvedValue(undefined),
  };
}

async function setup() {
  vi.spyOn(cancelScopeModule, 'beginCancelScope').mockImplementation(async () => ({
    dispose: vi.fn().mockResolvedValue(undefined), finish: vi.fn().mockResolvedValue(true),
  }) as never);
  const store = createMockSttModelStore();
  await store.download('whisper-tiny.en');
  const capture = stubCapture();
  const onErrorToast = vi.fn();
  const hook = renderHook(({ state }: { state: CaptureState }) => useDogfoodCapture({
    captureApi: { ...capture, captureState: state }, clipboard: { copy: vi.fn() },
    createModelStore: () => store, modelId: 'whisper-tiny.en', onErrorToast, onToast: vi.fn(),
  }), { initialProps: { state: { kind: 'idle' } as CaptureState } });
  const escape = () => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    act(() => { document.dispatchEvent(event); });
    return event.defaultPrevented;
  };
  return { ...hook, capture, escape, onErrorToast };
}

/** A pending promise and the function that settles it. */
function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((done) => { settle = done; });
  return { promise, settle };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('capture terminal events and the live session (BUS-91)', () => {
  it('a quick tap\'s empty stop does not end the re-hold that follows', async () => {
    const { capture, escape, onErrorToast, rerender, result } = await setup();
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    const release = deferred<void>();
    vi.mocked(capture.waitForCaptureRelease).mockReturnValueOnce(release.promise);
    let rehold!: Promise<void>;
    act(() => { rehold = result.current.start(); });
    await waitFor(() => expect(capture.waitForCaptureRelease).toHaveBeenCalledTimes(2));
    // The tap's capture ends with nothing recorded while the re-hold waits.
    rerender({ state: emptyStop });
    expect(result.current.phase).not.toBe('error');
    await act(async () => { release.settle(); await rehold; });
    expect(result.current.phase).toBe('recording');
    expect(onErrorToast).not.toHaveBeenCalledWith(EMPTY_STOP);
    expect(escape()).toBe(true);
    expect(result.current.phase).toBe('cancelled');
  });

  it('an empty stop from a cancelled session is ignored', async () => {
    const { escape, onErrorToast, rerender, result } = await setup();
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    expect(escape()).toBe(true);
    rerender({ state: emptyStop });
    expect(result.current.phase).toBe('cancelled');
    expect(onErrorToast).not.toHaveBeenCalledWith(EMPTY_STOP);
  });

  it('the current session\'s own empty stop still reports an error', async () => {
    const { onErrorToast, rerender, result } = await setup();
    await act(async () => { await result.current.start(); });
    rerender({ state: emptyStop });
    expect(result.current.phase).toBe('error');
    expect(onErrorToast).toHaveBeenCalledExactlyOnceWith(EMPTY_STOP);
  });

  it.each([
    [{ kind: 'cancelled' } as CaptureState, 'cancelled', 'Capture cancelled — nothing transcribed.'],
    [micLost, 'error', 'mic lost'],
  ] as const)('the session\'s own %o ends it while its start is pending', async (state, phase, message) => {
    const { capture, rerender, result } = await setup();
    const started = deferred<'ended'>();
    vi.mocked(capture.startFullCaptureSession).mockReturnValueOnce(started.promise);
    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(capture.startFullCaptureSession).toHaveBeenCalledOnce());
    rerender({ state });
    expect(result.current.phase).toBe(phase);
    expect(result.current.message).toBe(message);
    await act(async () => { started.settle('ended'); await start; });
    expect(result.current.phase).toBe(phase);
  });

  it('with no live session, an older capture\'s error is still shown', async () => {
    const { escape, rerender, result } = await setup();
    await act(async () => { await result.current.start(); });
    expect(escape()).toBe(true);
    rerender({ state: micLost });
    expect(result.current.phase).toBe('error');
    expect(result.current.message).toBe('mic lost');
  });
});
