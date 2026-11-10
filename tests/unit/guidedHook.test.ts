import * as cancelScope from '../../src/services/shortcut/cancelScope';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useDogfoodCapture } from '../../src/services/stt/useDogfoodCapture';
import { dogfoodTranscribeAndCopy } from '../../src/services/stt/dogfoodPath';
import { createMockSttModelStore } from '../../src/services/stt/mockStt';
import type { CaptureState } from '../../src/services/capture/types';
import type { UseCaptureStateResult } from '../../src/services/capture/useCaptureState';

it('requires an armed Escape scope in guided practice without changing ordinary degraded capture', async () => {
  const spy = vi.spyOn(cancelScope, 'beginCancelScope').mockRejectedValue(new Error('Input Monitoring off'));
  const store = createMockSttModelStore();
  await store.download('whisper-base.en');
  const start = vi.fn(async () => 'started');
  const { result } = renderHook(() => useDogfoodCapture({
    clipboard: { copy: vi.fn() }, modelId: 'whisper-base.en', createModelStore: () => store,
    deliveryGuard: { current: () => true, validate: async () => true, insert: () => true, result: vi.fn() },
    captureApi: { captureState: { kind: 'idle' }, startFullCaptureSession: start, cancelActiveCapture: vi.fn() } as unknown as UseCaptureStateResult,
  }));
  await act(async () => result.current.start('gesture'));
  expect(result.current.phase).toBe('error');
  expect(start).not.toHaveBeenCalled();
  spy.mockRestore();
});

it('keeps an owned practice guard through capture and cancels without late insertion during prerequisite validation', async () => {
  const store = createMockSttModelStore();
  await store.download('whisper-base.en');
  let resume!: () => void;
  const validation = new Promise<void>((resolve) => { resume = resolve; });
  const guard = { current: () => true, validate: vi.fn(async () => { await validation; return true; }), insert: vi.fn(() => true), result: vi.fn() };
  const clipboard = { copy: vi.fn() };
  const dogfood: typeof dogfoodTranscribeAndCopy = (options) => dogfoodTranscribeAndCopy({ ...options, createEngine: (modelId) => ({ modelId, transcribe: async () => ({ text: 'Boundary fixture' }) }) });
  const { result, rerender } = renderHook(({ captureState }: { captureState: CaptureState }) => useDogfoodCapture({
    clipboard, modelId: 'whisper-base.en', createModelStore: () => store, dogfood, deliveryGuard: guard,
    captureApi: { captureState, startFullCaptureSession: async () => 'started', stopFullCapture: async () => {}, cancelActiveCapture: vi.fn() } as unknown as UseCaptureStateResult,
  }), { initialProps: { captureState: { kind: 'idle' } as CaptureState } });
  await act(async () => result.current.start('gesture'));
  rerender({ captureState: { kind: 'stopped', audio: { id: 'practice-pcm', duration_ms: 1000, sample_rate_hz: 16000 } } });
  await waitFor(() => expect(guard.validate).toHaveBeenCalledOnce());
  act(() => result.current.cancel());
  await act(async () => { resume(); });
  expect(result.current.phase).toBe('cancelled');
  expect(guard.insert).not.toHaveBeenCalled();
  expect(guard.result).not.toHaveBeenCalled();
  expect(clipboard.copy).not.toHaveBeenCalled();
});

it('owned-capture-only practice never consumes stopped audio from a session it did not start with a guard', async () => {
  const store = createMockSttModelStore();
  await store.download('whisper-base.en');
  const dogfood = vi.fn(dogfoodTranscribeAndCopy);
  const { result, rerender } = renderHook(({ captureState }: { captureState: CaptureState }) => useDogfoodCapture({
    clipboard: { copy: vi.fn() }, modelId: 'whisper-base.en', createModelStore: () => store, dogfood, ownedCaptureOnly: true,
    deliveryGuard: () => undefined,
    captureApi: { captureState, startFullCaptureSession: async () => 'started', stopFullCapture: async () => {}, cancelActiveCapture: vi.fn() } as unknown as UseCaptureStateResult,
  }), { initialProps: { captureState: { kind: 'idle' } as CaptureState } });
  rerender({ captureState: { kind: 'stopped', audio: { id: 'product-pcm', duration_ms: 1000, sample_rate_hz: 16000 } } });
  await act(async () => {});
  expect(dogfood).not.toHaveBeenCalled();
  expect(result.current.phase).toBe('idle');
});
