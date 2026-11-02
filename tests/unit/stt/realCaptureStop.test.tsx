/** BUS-91: stops through the real capture hook bind to their own session. */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => Object.fromEntries([
  'cancelCapture', 'createCaptureRequestId', 'getCaptureStatus', 'isTauriEnv', 'listDevices',
  'onCaptureEvent', 'queryPermission', 'requestPermission', 'startFullCapture', 'startMicTest',
  'stopCapture'].map((name) => [name, vi.fn()])) as CaptureMocks);
vi.unmock('../../../src/services/capture/useCaptureState');
vi.mock('../../../src/services/capture/captureService', () => mocks);

import { useCaptureState, type StoppedCapture } from '../../../src/services/capture/useCaptureState';
import { SUPERSEDED_DELIVERY_MESSAGE } from '../../../src/services/delivery';
import { installCaptureBus, type CaptureMocks } from './captureBus';
import { setup } from './dogfoodHarness';

let bus: ReturnType<typeof installCaptureBus>;
const handler = (event: Parameters<typeof bus.emit>[0]) => bus.emit(event);
const stopOf = (index: number, id: string) => bus.stopOf(index, id);
beforeEach(async () => { bus = installCaptureBus(mocks); });
afterEach(() => { vi.restoreAllMocks(); });

describe('capture stop release and owner echo (BUS-91)', () => {
  it('a restart after a stop waits for the stop instead of busy', async () => {
    const { result } = renderHook(() => useCaptureState());
    await waitFor(() => expect(bus.listening()).toBe(true));
    await act(async () => { await result.current.startFullCaptureSession(undefined, 'tap'); });
    await act(async () => { await result.current.stopFullCapture(); });
    let released = false;
    const wait = result.current.waitForCaptureRelease().then(() => { released = true; });
    await act(async () => { await Promise.resolve(); });
    expect(released).toBe(false);
    act(() => handler(stopOf(0, 'a')));
    await act(async () => { await wait; });
    await act(async () => {
      expect(await result.current.startFullCaptureSession(undefined, 'hold')).toBe('started');
    });
  });

  it('two stops in one batch both reach the listener with their own owner', async () => {
    const { result } = renderHook(() => useCaptureState());
    await waitFor(() => expect(bus.listening()).toBe(true));
    const seen: StoppedCapture[] = [];
    result.current.onCaptureStopped?.((stopped) => { seen.push(stopped); });
    await act(async () => { await result.current.startFullCaptureSession(undefined, 'A'); });
    await act(async () => {
      await result.current.stopFullCapture();
      const wait = result.current.waitForCaptureRelease();
      handler(stopOf(0, 'a'));
      await wait;
      await result.current.startFullCaptureSession(undefined, 'B');
      await result.current.stopFullCapture();
      handler(stopOf(1, 'b'));
    });
    expect(seen.map(({ audio, owner }) => [audio?.id, owner])).toEqual([['a', 'A'], ['b', 'B']]);
    expect(result.current.captureState).toMatchObject({ audio: { id: 'b' }, owner: 'B' });
  });

  it('a tap\'s stop batched with the re-hold\'s start still reaches History', async () => {
    const { insert, onHistoryRecord, onToast, result } = await setup({ useCapture: useCaptureState });
    await waitFor(() => expect(bus.listening()).toBe(true));
    await act(async () => { await result.current.start(); });
    expect(result.current.phase).toBe('recording');
    await act(async () => { await result.current.stop(); });
    await act(async () => {
      // The handler's path: a stop was requested, so start without cancel().
      expect(result.current.stopRequested?.()).toBe(true);
      const rehold = result.current.start('gesture');
      await new Promise((done) => setTimeout(done, 0));
      handler(stopOf(0, 'tap')); // its 'stopped' and the restart's 'active' batch together
      await rehold;
    });
    expect(mocks.startFullCapture).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toBe('recording');
    await waitFor(() => expect(onHistoryRecord).toHaveBeenCalledOnce());
    expect(onHistoryRecord.mock.calls[0][0]).toMatchObject({ status: 'failed', text: 'tap words' });
    expect(insert).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenLastCalledWith(SUPERSEDED_DELIVERY_MESSAGE);
    expect(mocks.cancelCapture).not.toHaveBeenCalled();
  });
});
