/** BUS-91: stops through the real capture hook bind to their own session. */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cancelCapture: vi.fn(), createCaptureRequestId: vi.fn(), getCaptureStatus: vi.fn(),
  isTauriEnv: vi.fn(), listDevices: vi.fn(), onCaptureEvent: vi.fn(),
  queryPermission: vi.fn(), requestPermission: vi.fn(), startFullCapture: vi.fn(),
  startMicTest: vi.fn(), stopCapture: vi.fn(),
}));
vi.unmock('../../../src/services/capture/useCaptureState');
vi.mock('../../../src/services/capture/captureService', () => mocks);

import type { CaptureEvent } from '../../../src/services/capture/types';
import { useCaptureState, type StoppedCapture } from '../../../src/services/capture/useCaptureState';
import { SUPERSEDED_DELIVERY_MESSAGE } from '../../../src/services/delivery';
import { setup } from './dogfoodHarness';

let handlers: ((event: CaptureEvent) => void)[] = [];
/** Native events reach every mounted capture hook, as on the real bus. */
const handler = (event: CaptureEvent) => {
  for (const listener of handlers) listener(event);
};
let nextId = 1;
const clip = (id: string) => ({ duration_ms: 400, id, sample_rate_hz: 16_000 });
/** The native stop of the `index`th full capture. */
const stopOf = (index: number, id: string): CaptureEvent => ({
  audio: clip(id), generation: 3, kind: 'capture-stopped',
  request_id: mocks.startFullCapture.mock.calls[index][0] as string,
});

beforeEach(() => {
  vi.clearAllMocks();
  handlers = [];
  nextId = 1;
  mocks.cancelCapture.mockResolvedValue(true);
  mocks.createCaptureRequestId.mockImplementation(() => `request-${nextId++}`);
  mocks.getCaptureStatus.mockResolvedValue(null);
  mocks.isTauriEnv.mockReturnValue(true);
  mocks.listDevices.mockResolvedValue([]);
  mocks.onCaptureEvent.mockImplementation(async (callback) => {
    handlers.push(callback);
    return () => { handlers = handlers.filter((item) => item !== callback); };
  });
  mocks.queryPermission.mockResolvedValue(undefined);
  mocks.startFullCapture.mockImplementation(async (requestId) => ({
    generation: 3, mode: 'full', request_id: requestId,
  }));
  mocks.stopCapture.mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('capture stop release and owner echo (BUS-91)', () => {
  it('a restart after a stop waits for the stop instead of busy', async () => {
    const { result } = renderHook(() => useCaptureState());
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0));
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
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0));
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
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0));
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
