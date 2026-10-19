/** BUS-91: which capture terminal events a dogfood session acts on. */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptureState } from '../../../src/services/capture/types';
import type { UseCaptureStateResult } from '../../../src/services/capture/useCaptureState';
import { createStubDeliveryAdapter, type TargetSnapshot } from '../../../src/services/delivery';
import * as cancelScopeModule from '../../../src/services/shortcut/cancelScope';
import { dogfoodTranscribeAndCopy } from '../../../src/services/stt/dogfoodPath';
import { createMockSttEngine, createMockSttModelStore } from '../../../src/services/stt/mockStt';
import { useDogfoodCapture } from '../../../src/services/stt/useDogfoodCapture';

const EMPTY_STOP = 'Capture stopped without audio — nothing to transcribe.';
const emptyStop: CaptureState = { kind: 'stopped' };
const micLost: CaptureState = { category: 'busy', kind: 'error', message: 'mic lost' };
const tapAudio: CaptureState = {
  audio: { duration_ms: 400, id: 'tap-audio', sample_rate_hz: 16_000 }, kind: 'stopped',
};
const target: TargetSnapshot = {
  appName: 'Notes', appPid: 42, capturedAt: 1, elementId: 'C',
  elementRole: 'AXTextArea', insertable: true, kind: 'insertable', reason: null,
};

/** Like the native scope: closed by finish or dispose, then finish is false. */
function nativeLikeScope() {
  let closed = false;
  return {
    dispose: vi.fn(async () => { closed = true; }),
    finish: vi.fn(async () => { const open = !closed; closed = true; return open; }),
  };
}

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
  const scopes: ReturnType<typeof nativeLikeScope>[] = [];
  vi.spyOn(cancelScopeModule, 'beginCancelScope').mockImplementation(async () => {
    scopes.push(nativeLikeScope());
    return scopes[scopes.length - 1];
  });
  const store = createMockSttModelStore();
  await store.download('whisper-tiny.en');
  const capture = stubCapture();
  const onErrorToast = vi.fn();
  const onHistoryRecord = vi.fn();
  const insert = vi.fn().mockResolvedValue(undefined);
  const transcribe = vi.fn(async () => ({ language: 'en', text: 'tap words' }));
  const clipboard = { copy: vi.fn() };
  const deliveryPlatform = createStubDeliveryAdapter({
    clipboard, insert, snapshot: async () => target, validate: async (intended) => intended,
  });
  const dogfood: typeof dogfoodTranscribeAndCopy = (options) => dogfoodTranscribeAndCopy({
    ...options, createEngine: (modelId) => ({ ...createMockSttEngine({ modelId }), transcribe }),
  });
  const hook = renderHook(({ state }: { state: CaptureState }) => useDogfoodCapture({
    captureApi: { ...capture, captureState: state }, clipboard, createModelStore: () => store,
    deliveryPlatform, dogfood, modelId: 'whisper-tiny.en', onErrorToast, onHistoryRecord,
    onToast: vi.fn(),
  }), { initialProps: { state: { kind: 'idle' } as CaptureState } });
  const escape = () => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    act(() => { document.dispatchEvent(event); });
    return event.defaultPrevented;
  };
  return { ...hook, capture, escape, insert, onErrorToast, onHistoryRecord, scopes, transcribe };
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

  it('a quick tap\'s stop with audio is kept under its own session; the re-hold stays live', async () => {
    const {
      capture, escape, insert, onHistoryRecord, rerender, result, scopes,
    } = await setup();
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    const release = deferred<void>();
    vi.mocked(capture.waitForCaptureRelease).mockReturnValueOnce(release.promise);
    let rehold!: Promise<void>;
    act(() => { rehold = result.current.start(); });
    await waitFor(() => expect(capture.waitForCaptureRelease).toHaveBeenCalledTimes(2));
    // The tap's audio lands while the re-hold waits: processed, superseded.
    rerender({ state: tapAudio });
    await waitFor(() => expect(onHistoryRecord).toHaveBeenCalledOnce());
    expect(onHistoryRecord.mock.calls[0][0]).toMatchObject({ text: 'tap words' });
    expect(insert).not.toHaveBeenCalled();
    await act(async () => { release.settle(); await rehold; });
    expect(result.current.phase).toBe('recording');
    expect(scopes).toHaveLength(2);
    expect(scopes[1].finish).not.toHaveBeenCalled();
    expect(scopes[1].dispose).not.toHaveBeenCalled();
    expect(escape()).toBe(true);
    expect(result.current.phase).toBe('cancelled');
    expect(scopes[1].dispose).toHaveBeenCalled();
  });

  it('a tap whose Escape is still queued natively is discarded at the re-hold', async () => {
    const { capture, onHistoryRecord, rerender, result, scopes, transcribe } = await setup();
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    scopes[0].finish.mockResolvedValueOnce(false); // the latch saw Escape
    const release = deferred<void>();
    vi.mocked(capture.waitForCaptureRelease).mockReturnValueOnce(release.promise);
    let rehold!: Promise<void>;
    act(() => { rehold = result.current.start(); });
    await waitFor(() => expect(capture.waitForCaptureRelease).toHaveBeenCalledTimes(2));
    rerender({ state: tapAudio });
    await act(async () => { release.settle(); await rehold; });
    expect(transcribe).not.toHaveBeenCalled();
    expect(onHistoryRecord).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('recording');
  });

  it('tap, Escape, then the tap\'s stop with audio: stays cancelled', async () => {
    const { escape, onHistoryRecord, rerender, result, transcribe } = await setup();
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    expect(escape()).toBe(true);
    rerender({ state: tapAudio });
    expect(result.current.phase).toBe('cancelled');
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
    expect(result.current.phase).toBe('cancelled');
    expect(result.current.message).toBe('Capture cancelled — nothing transcribed.');
    expect(transcribe).not.toHaveBeenCalled();
    expect(onHistoryRecord).not.toHaveBeenCalled();
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
