import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDogfoodCapture } from '../../src/services/stt/useDogfoodCapture';
import { createMockSttModelStore, createMockSttEngine } from '../../src/services/stt/mockStt';
import { dogfoodTranscribeAndCopy } from '../../src/services/stt/dogfoodPath';
import { createStubDeliveryAdapter } from '../../src/services/delivery';
import type { UseCaptureStateResult } from '../../src/services/capture/useCaptureState';
import type { CaptureState } from '../../src/services/capture/types';

const native = vi.hoisted(() => ({ begin: vi.fn(), finish: vi.fn(), dispose: vi.fn(), cancel: () => {} }));
vi.mock('../../src/services/shortcut/cancelScope', () => ({ beginCancelScope: native.begin }));

function capture(state: CaptureState): UseCaptureStateResult {
  return {
    captureState: state, captureReady: true, devices: [], devicesLoading: false, deviceListError: null,
    permissionStatus: 'authorized', cancelActiveCapture: vi.fn(), startFullCaptureSession: vi.fn().mockResolvedValue('started'),
    stopFullCapture: vi.fn(), stopMicTest: vi.fn(), requestMicPermission: vi.fn(),
    refreshDevices: vi.fn(), runMicTest: vi.fn(), prepareDeviceChange: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  native.finish.mockResolvedValue(true);
  native.dispose.mockResolvedValue(undefined);
  native.begin.mockImplementation(async (cancel) => { native.cancel = cancel; return native; });
});

describe('BUS-43 native cancellation integration', () => {
  it('unmount cancels recording and releases the native scope', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const api = capture({ kind: 'idle' });
    const { result, unmount } = renderHook(() => useDogfoodCapture({
      captureApi: api, clipboard: { copy: vi.fn() }, createModelStore: () => store, modelId: 'whisper-tiny.en',
    }));
    await act(async () => { await result.current.start(); });
    unmount();
    expect(native.dispose).toHaveBeenCalled();
    expect(api.cancelActiveCapture).toHaveBeenCalled();
  });

  it.each(['denied', 'rejected', 'accepted'] as const)(
    'settles native cancellation before surfacing an STT rejection (%s)', async (mode) => {
      const store = createMockSttModelStore();
      await store.download('whisper-tiny.en');
      let reject!: (error: Error) => void;
      const transcribe = vi.fn(() => new Promise<never>((_, fail) => { reject = fail; }));
      const clip = { copy: vi.fn() };
      const snapshot = vi.fn();
      const history = vi.fn();
      const toast = vi.fn();
      const dogfood: typeof dogfoodTranscribeAndCopy = (options) => dogfoodTranscribeAndCopy({
        ...options, createEngine: () => ({ ...createMockSttEngine(), transcribe }),
      });
      const { result, rerender } = renderHook(({ state }: { state: CaptureState }) => useDogfoodCapture({
        captureApi: capture(state), clipboard: clip, createModelStore: () => store, modelId: 'whisper-tiny.en',
        onHistoryRecord: history, onToast: toast, dogfood,
        deliveryPlatform: createStubDeliveryAdapter({ clipboard: clip, snapshot }),
      }), { initialProps: { state: { kind: 'idle' } as CaptureState } });
      await act(async () => { await result.current.start(); });
      rerender({ state: { kind: 'stopped', audio: { id: 'native-rejection', duration_ms: 1000, sample_rate_hz: 16000 } } });
      await waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
      // The native event is deliberately never delivered to JavaScript.
      if (mode === 'denied') native.finish.mockResolvedValue(false);
      if (mode === 'rejected') native.finish.mockRejectedValue(new Error('IPC failed'));
      toast.mockClear();
      await act(async () => { reject(new Error('late STT failure')); });
      expect(native.finish).toHaveBeenCalledOnce();
      expect(result.current.phase).toBe(mode === 'accepted' ? 'error' : 'cancelled');
      if (mode === 'accepted') expect(toast).toHaveBeenCalledWith('late STT failure');
      else expect(toast).not.toHaveBeenCalled();
      expect(history).not.toHaveBeenCalled();
      expect(snapshot).not.toHaveBeenCalled();
      expect(clip.copy).not.toHaveBeenCalled();
      expect(native.dispose).toHaveBeenCalled();
    });

  it.each(['denied', 'rejected', 'event'] as const)('native cancellation (%s) beats a late transcript', async (mode) => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    let resume!: () => void;
    const pending = new Promise<void>((resolve) => { resume = resolve; });
    const transcribe = vi.fn(async () => { await pending; return { text: 'discard me', language: 'en' }; });
    const clip = { copy: vi.fn() };
    const snapshot = vi.fn().mockResolvedValue(null);
    const insert = vi.fn();
    const history = vi.fn();
    const dogfood: typeof dogfoodTranscribeAndCopy = (options) => dogfoodTranscribeAndCopy({
      ...options, createEngine: () => ({ ...createMockSttEngine(), transcribe }),
    });
    const { result, rerender } = renderHook(({ state }: { state: CaptureState }) => useDogfoodCapture({
      captureApi: capture(state), clipboard: clip, createModelStore: () => store, modelId: 'whisper-tiny.en',
      onHistoryRecord: history, dogfood, deliveryPlatform: createStubDeliveryAdapter({ clipboard: clip, snapshot, insert }),
    }), { initialProps: { state: { kind: 'idle' } as CaptureState } });
    await act(async () => { await result.current.start(); });
    expect(native.begin).toHaveBeenCalledOnce();
    rerender({ state: { kind: 'stopped', audio: { id: 'native-cancel', duration_ms: 1000, sample_rate_hz: 16000 } } });
    await waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
    if (mode === 'denied') native.finish.mockResolvedValue(false);
    if (mode === 'rejected') native.finish.mockRejectedValue(new Error('IPC failed'));
    if (mode === 'event') act(() => { native.cancel(); });
    await act(async () => { resume(); });
    expect(native.finish).toHaveBeenCalledTimes(mode === 'event' ? 0 : 1);
    expect(snapshot).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(clip.copy).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('cancelled');
    expect(result.current.transcript).toBeNull();
  });
});
