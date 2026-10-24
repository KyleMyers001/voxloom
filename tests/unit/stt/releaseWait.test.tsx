/** BUS-91: the re-hold's wait for a stopping tap, through the real capture hook. */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => Object.fromEntries([
  'cancelCapture', 'createCaptureRequestId', 'getCaptureStatus', 'isTauriEnv', 'listDevices',
  'onCaptureEvent', 'queryPermission', 'requestPermission', 'startFullCapture', 'startMicTest',
  'stopCapture'].map((name) => [name, vi.fn()])) as CaptureMocks);
vi.unmock('../../../src/services/capture/useCaptureState');
vi.mock('../../../src/services/capture/captureService', () => mocks);

import { useCaptureState } from '../../../src/services/capture/useCaptureState';
import { SUPERSEDED_DELIVERY_MESSAGE } from '../../../src/services/delivery';
import { installCaptureBus, type CaptureMocks } from './captureBus';
import { EMPTY_STOP, setup } from './dogfoodHarness';

let bus: ReturnType<typeof installCaptureBus>;
beforeEach(() => { bus = installCaptureBus(mocks); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** A tap with audio whose stop is still on the way, then a re-hold waiting for it. */
async function tapThenRehold() {
  const hook = await setup({ useCapture: useCaptureState });
  await waitFor(() => expect(bus.listening()).toBe(true));
  await act(async () => { await hook.result.current.start(); });
  await act(async () => { await hook.result.current.stop(); });
  let rehold!: Promise<void>;
  act(() => { rehold = hook.result.current.start('gesture'); });
  await act(async () => { await new Promise((done) => setTimeout(done, 10)); });
  return { ...hook, rehold };
}

describe('re-hold waiting for a stopping tap (BUS-91)', () => {
  it.each(['Escape', 'Home Cancel'])('%s during the wait keeps the tap and cancels only the re-hold', async (how) => {
    const { escape, onHistoryRecord, onToast, rehold, result, scopes } = await tapThenRehold();
    expect(scopes).toHaveLength(1); // the re-hold arms Escape only after the release
    expect(result.current.hudReady).toBe(false);
    if (how === 'Escape') expect(escape()).toBe(true);
    else act(() => result.current.cancel());
    expect(result.current.phase).toBe('cancelled');
    expect(mocks.cancelCapture).not.toHaveBeenCalled(); // the tap's capture is not cancelled
    act(() => bus.emit(bus.stopOf(0, 'tap')));
    await act(async () => { await rehold; });
    await waitFor(() => expect(onHistoryRecord).toHaveBeenCalledOnce());
    expect(onHistoryRecord.mock.calls[0][0]).toMatchObject({ status: 'failed', text: 'tap words' });
    expect(mocks.startFullCapture).toHaveBeenCalledOnce(); // the mic never reopened
    expect(result.current.phase).toBe('cancelled');
    // The user cancelled: no "replaced" toast even though the stop won.
    expect(onToast).not.toHaveBeenCalledWith(expect.stringContaining(SUPERSEDED_DELIVERY_MESSAGE));
    await act(async () => { await result.current.start(); }); // the mic is free
    expect(result.current.phase).toBe('recording');
  });

  it('releasing during the wait cancels without opening the mic', async () => {
    const { onErrorToast, onHistoryRecord, onToast, rehold, result } = await tapThenRehold();
    await act(async () => { await result.current.stop(); });
    expect(mocks.stopCapture).toHaveBeenCalledOnce(); // the tap's stop is not repeated
    act(() => bus.emit(bus.stopOf(0, 'tap')));
    await act(async () => { await rehold; });
    expect(mocks.startFullCapture).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe('cancelled');
    expect(onErrorToast).not.toHaveBeenCalledWith(EMPTY_STOP);
    await waitFor(() => expect(onHistoryRecord).toHaveBeenCalledOnce());
    expect(onHistoryRecord.mock.calls[0][0]).toMatchObject({ status: 'failed', text: 'tap words' });
    expect(onToast).toHaveBeenLastCalledWith(SUPERSEDED_DELIVERY_MESSAGE); // a release, not a cancel
  });
});

describe('release timeout (BUS-91)', () => {
  it('is bounded at 5 s, then cancels the stuck capture so the next start works', async () => {
    const { result } = renderHook(() => useCaptureState());
    await waitFor(() => expect(bus.listening()).toBe(true));
    await act(async () => { await result.current.startFullCaptureSession(undefined, 'tap'); });
    await act(async () => { await result.current.stopFullCapture(); });
    vi.useFakeTimers();
    let released: boolean | null = null;
    const wait = result.current.waitForCaptureRelease().then((value) => { released = value; });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
    expect(released).toBeNull();
    expect(mocks.cancelCapture).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); await wait; });
    expect(released).toBe(false); // timed out
    expect(mocks.cancelCapture).toHaveBeenCalledExactlyOnceWith(bus.requestOf(0));
    expect(result.current.captureState).toEqual({ kind: 'idle' }); // the UI shows no live capture
    await act(async () => {
      expect(await result.current.startFullCaptureSession(undefined, 'hold')).toBe('started');
    });
    act(() => bus.emit(bus.stopOf(0, 'late'))); // the lost stop is ignored
    expect(result.current.captureState).toMatchObject({ kind: 'active' });
  });

  it('after a timeout, the next start waits for the cancelled capture to end (Codex 4319386390)', async () => {
    const { result } = renderHook(() => useCaptureState());
    await waitFor(() => expect(bus.listening()).toBe(true));
    await act(async () => { await result.current.startFullCaptureSession(undefined, 'tap'); });
    await act(async () => { await result.current.stopFullCapture(); });
    vi.useFakeTimers();
    const timedOut = result.current.waitForCaptureRelease();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(await timedOut).toBe(false);
    let released: boolean | null = null;
    const next = result.current.waitForCaptureRelease().then((value) => { released = value; });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(released).toBeNull(); // native still holds the mic
    act(() => bus.emit({ generation: 3, kind: 'capture-cancelled', request_id: bus.requestOf(0) } as never));
    await act(async () => { await next; });
    expect(released).toBe(true);
  });

  it('after a timeout, a cancel that never ends either is waited for once, then dropped', async () => {
    const { result } = renderHook(() => useCaptureState());
    await waitFor(() => expect(bus.listening()).toBe(true));
    await act(async () => { await result.current.startFullCaptureSession(undefined, 'tap'); });
    await act(async () => { await result.current.stopFullCapture(); });
    vi.useFakeTimers();
    const first = result.current.waitForCaptureRelease();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    const second = result.current.waitForCaptureRelease();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect([await first, await second]).toEqual([false, false]);
    expect(await result.current.waitForCaptureRelease()).toBe(true);
  });
});
