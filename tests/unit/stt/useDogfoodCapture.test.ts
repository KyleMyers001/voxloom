/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type {
  CleanupProvenance,
  DictationRecord,
} from '../../../src/domain/types';
import type { ClipboardAdapter } from '../../../src/services/clipboard';
import { CleanupEngineError } from '../../../src/services/cleanup';
import type { DeliveryPlatformAdapter, TargetSnapshot } from
  '../../../src/services/delivery';
import type { CaptureState } from '../../../src/services/capture/types';
import type { UseCaptureStateResult } from
  '../../../src/services/capture/useCaptureState';
import {
  dogfoodTranscribeAndCopy,
  type DogfoodResult,
  type DogfoodTranscribeOptions,
} from '../../../src/services/stt/dogfoodPath';
import { createStubDeliveryAdapter } from '../../../src/services/delivery';
import {
  createMockSttEngine,
  createMockSttModelStore,
} from '../../../src/services/stt/mockStt';
import { useDogfoodCapture } from
  '../../../src/services/stt/useDogfoodCapture';
import * as cancelScopeModule from '../../../src/services/shortcut/cancelScope';

function clipboard(): ClipboardAdapter {
  return { copy: vi.fn().mockResolvedValue(undefined) };
}

function deliveryOutcome(
  status: 'inserted' | 'copied' | 'failed',
  text: string,
  message?: string,
) {
  return {
    clipboardRestored: false,
    detail: status === 'failed' ? 'NotAllowedError' : null,
    message: message
      ?? (status === 'copied'
        ? 'Copied — test'
        : status === 'inserted'
        ? 'Inserted'
        : 'Failed — NotAllowedError'),
    restoreSkippedReason: null,
    status,
    text,
    writeCommitted: status !== 'failed',
    writeStarted: status !== 'failed',
  };
}


function stubCapture(state: CaptureState): UseCaptureStateResult {
  return {
    cancelActiveCapture: vi.fn(),
    captureReady: true,
    captureState: state,
    deviceListError: null,
    devices: [],
    devicesLoading: false,
    permissionStatus: 'authorized',
    prepareDeviceChange: vi.fn().mockResolvedValue(true),
    refreshDevices: vi.fn().mockResolvedValue(undefined),
    requestMicPermission: vi.fn(),
    runMicTest: vi.fn(),
    startFullCaptureSession: vi.fn().mockResolvedValue('started'),
    stopFullCapture: vi.fn(),
    stopMicTest: vi.fn(),
  };
}

async function mockDogfoodSuccess(
  { modelId, audio }: { modelId: string; audio: { duration_ms: number; id: string; sample_rate_hz: number } },
): Promise<DogfoodResult> {
  const engine = createMockSttEngine({ modelId });
  const transcript = await engine.transcribe({
    durationMs: audio.duration_ms,
    id: audio.id,
    sampleRateHz: audio.sample_rate_hz,
  });
  return {
    copied: true,
    delivery: {
      clipboardRestored: false,
      detail: 'test',
      message: 'Copied — test',
      restoreSkippedReason: null,
      status: 'copied' as const,
      text: transcript.text,
      writeCommitted: true,
      writeStarted: true,
    },
    transcript,
  };
}

describe('useDogfoodCapture', () => {
  it('owns deferred capture acquisition across racing starts', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    let acquired!: (status: 'started') => void;
    const startFullCaptureSession = vi.fn(() =>
      new Promise<'started'>((resolve) => { acquired = resolve; }));
    const { result } = renderHook(() => useDogfoodCapture({
      captureApi: {
        ...stubCapture({ kind: 'idle' }),
        startFullCaptureSession,
      },
      clipboard: clipboard(),
      createModelStore: () => store,
      modelId: 'whisper-tiny.en',
    }));

    let first!: Promise<void>;
    act(() => { first = result.current.start(); });
    await waitFor(() => expect(startFullCaptureSession).toHaveBeenCalledOnce());
    await act(async () => { await result.current.start(); });
    expect(startFullCaptureSession).toHaveBeenCalledOnce();
    acquired('started');
    await act(async () => { await first; });
    expect(result.current.phase).toBe('recording');
  });

  it.each([
    ['A', 'B', 'B', false, true, 'inserted'],
    ['A', 'auto', 'C', false, true, 'inserted'],
    ['A', 'race', 'C', false, true, 'copied'],
    ['A', 'race', 'C', false, false, 'failed'],
    ['A', 'B', 'C', false, true, 'inserted'],
    ['A', 'B', 'C', false, false, 'inserted'],
    ['A', 'A', 'A', false, true, 'inserted'],
    ['A', 'B', 'B', true, true, 'copied'],
    ['A', 'B', 'C', true, false, 'failed'],
  ] as const)('completion target %s→%s→%s secure=%s fallback=%s yields %s',
    async (startField, stopField, finalField, secure, fallback, status) => {
      const store = createMockSttModelStore();
      await store.download('whisper-tiny.en');
      const clip = clipboard();
      let focus = startField as string;
      const inserted = vi.fn().mockResolvedValue(undefined);
      const snapshot = vi.fn(async (): Promise<TargetSnapshot> => ({
        appName: 'Notes', appPid: 42, capturedAt: 1,
        elementId: focus, elementRole: 'AXTextArea',
        insertable: !secure, kind: secure ? 'secure' : 'insertable', reason: null,
      }));
      const platform = createStubDeliveryAdapter({
        clipboard: clip, snapshot, insert: inserted,
        validate: async (intended) => intended.elementId === (stopField === 'race' ? 'D' : focus)
          ? intended : { ...intended, insertable: false, kind: 'changed', reason: 'focus changed' },
      });
      let resolveStt!: (value: { text: string; language: string }) => void;
      const transcribe = vi.fn(() => new Promise<{ text: string; language: string }>((resolve) => {
        resolveStt = resolve;
      }));
      const dogfood: typeof dogfoodTranscribeAndCopy = (options) => dogfoodTranscribeAndCopy({
        ...options,
        createEngine: (modelId) => ({ ...createMockSttEngine({ modelId }), transcribe }),
      });
      const { result, rerender } = renderHook(({ state }: { state: CaptureState }) => useDogfoodCapture({
        captureApi: stubCapture(state), clipboard: clip, clipboardFallback: fallback,
        createModelStore: () => store, deliveryPlatform: platform, dogfood,
        modelId: 'whisper-tiny.en',
      }), { initialProps: { state: { kind: 'idle' } as CaptureState } });
      await act(async () => { await result.current.start(); });
      focus = stopField;
      if (stopField !== 'auto') await act(async () => { await result.current.stop(); });
      expect(snapshot).not.toHaveBeenCalled();
      expect(result.current.intendedTarget).toBeNull();
      rerender({ state: { kind: 'stopped', audio: {
        id: 'release-audio', duration_ms: 700, sample_rate_hz: 16_000,
      } } });
      await waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
      expect(snapshot).not.toHaveBeenCalled();
      focus = finalField;
      await act(async () => { resolveStt({ text: 'release transcript', language: 'en' }); });
      await waitFor(() => expect(result.current.phase).toBe('success'));
      expect(result.current.message?.toLowerCase()).toMatch(new RegExp(`^${status}`));
      expect(inserted).toHaveBeenCalledTimes(status === 'inserted' ? 1 : 0);
      if (status === 'inserted') expect(inserted).toHaveBeenCalledWith(
        'release transcript', expect.objectContaining({ elementId: finalField }),
      );
      expect(clip.copy).toHaveBeenCalledTimes(status === 'copied' ? 1 : 0);
      expect(snapshot).toHaveBeenCalledOnce();
      expect(result.current.intendedTarget?.elementId).toBe(finalField);
    });

  it.each(['stt', 'snapshot', 'validate', 'cancel'] as const)(
    'superseding during %s prevents stale delivery and preserves the newer phase', async (stage) => {
      const store = createMockSttModelStore();
      await store.download('whisper-tiny.en');
      const clip = clipboard();
      const target: TargetSnapshot = {
        appName: 'Notes', appPid: 42, capturedAt: 1, elementId: 'C',
        elementRole: 'AXTextArea', insertable: true, kind: 'insertable', reason: null,
      };
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => { resume = resolve; });
      const insert = vi.fn();
      const snapshot = vi.fn(async () => { if (stage === 'snapshot') await gate; return target; });
      const validate = vi.fn(async () => { if (stage === 'validate') await gate; return target; });
      const transcribe = vi.fn(async () => {
        if (stage === 'stt' || stage === 'cancel') await gate;
        return { text: 'old transcript', language: 'en' };
      });
      const history = vi.fn();
      const dogfood: typeof dogfoodTranscribeAndCopy = (options) => dogfoodTranscribeAndCopy({
        ...options, createEngine: (modelId) => ({ ...createMockSttEngine({ modelId }), transcribe }),
      });
      const { result, rerender } = renderHook(({ state }: { state: CaptureState }) => useDogfoodCapture({
        captureApi: stubCapture(state), clipboard: clip,
        createModelStore: () => store, modelId: 'whisper-tiny.en', dogfood,
        onHistoryRecord: history,
        deliveryPlatform: createStubDeliveryAdapter({ clipboard: clip, snapshot, validate, insert }),
      }), { initialProps: { state: { kind: 'idle' } as CaptureState } });
      await act(async () => { await result.current.start(); await result.current.stop(); });
      rerender({ state: { kind: 'stopped', audio: {
        id: 'old-audio', duration_ms: 700, sample_rate_hz: 16_000,
      } } });
      await waitFor(() => expect(stage === 'stt' || stage === 'cancel' ? transcribe : stage === 'snapshot' ? snapshot : validate).toHaveBeenCalledOnce());
      rerender({ state: { kind: 'idle' } });
      await act(async () => {
        if (stage === 'cancel') result.current.cancel();
        else await result.current.start();
        resume(); });
      if (stage === 'cancel') expect(history).not.toHaveBeenCalled();
      else await waitFor(() => expect(history).toHaveBeenCalledOnce());
      expect(insert).not.toHaveBeenCalled();
      expect(clip.copy).not.toHaveBeenCalled();
      if (stage === 'stt') expect(snapshot).not.toHaveBeenCalled();
      expect(result.current.intendedTarget).toBeNull();
      expect(result.current.phase).toBe(stage === 'cancel' ? 'cancelled' : 'recording');
      if (stage !== 'cancel') expect(history).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    });

  it('cancel suppresses a late transcription rejection and allows the next session', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    let reject!: (error: Error) => void;
    const dogfood = vi.fn(() => new Promise<DogfoodResult>((_, fail) => { reject = fail; }));
    const toast = vi.fn();
    const history = vi.fn();
    const { result, rerender } = renderHook(({ state }: { state: CaptureState }) => useDogfoodCapture({
      captureApi: stubCapture(state), clipboard: clipboard(), createModelStore: () => store,
      dogfood, modelId: 'whisper-tiny.en', onToast: toast, onHistoryRecord: history,
    }), { initialProps: { state: { kind: 'stopped', audio: {
      id: 'late-error', duration_ms: 700, sample_rate_hz: 16_000,
    } } as CaptureState } });
    await waitFor(() => expect(dogfood).toHaveBeenCalledOnce());
    act(() => result.current.cancel());
    toast.mockClear();
    await act(async () => { reject(new Error('late failure')); });
    expect(toast).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('cancelled');
    rerender({ state: { kind: 'idle' } });
    await act(async () => { await result.current.start(); });
    expect(result.current.phase).toBe('recording');
  });

  it('Escape cancels pending capture startup, ignores idle Escape, and can restart', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    let acquired!: (value: 'started') => void;
    const capture = stubCapture({ kind: 'idle' });
    capture.startFullCaptureSession = vi.fn(() => new Promise<'started'>((resolve) => { acquired = resolve; }));
    const { result } = renderHook(() => useDogfoodCapture({
      captureApi: capture, clipboard: clipboard(), createModelStore: () => store, modelId: 'whisper-tiny.en',
    }));
    const idle = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    document.dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false);
    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(capture.startFullCaptureSession).toHaveBeenCalledOnce());
    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    act(() => { document.dispatchEvent(escape); });
    expect(escape.defaultPrevented).toBe(true);
    expect(capture.cancelActiveCapture).toHaveBeenCalledOnce();
    await act(async () => { acquired('started'); await start; });
    expect(result.current.phase).toBe('cancelled');
    vi.mocked(capture.startFullCaptureSession).mockResolvedValue('started');
    await act(async () => { await result.current.start(); });
    expect(result.current.phase).toBe('recording');
  });

  it('does not claim recording when capture is still owned by a previous hold', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const toast = vi.fn();
    const startFullCaptureSession = vi.fn().mockResolvedValue('busy');
    const stopFullCapture = vi.fn();
    const { result } = renderHook(() => useDogfoodCapture({
      captureApi: {
        ...stubCapture({ kind: 'idle' }),
        startFullCaptureSession,
        stopFullCapture,
      },
      clipboard: clipboard(),
      createModelStore: () => store,
      modelId: 'whisper-tiny.en',
      onToast: toast,
    }));

    await act(async () => { await result.current.start(); });
    expect(result.current.phase).toBe('error');
    expect(result.current.message).toMatch(/already active/i);
    expect(stopFullCapture).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/already active/i));
  });

  it('waits for acquisition and honors a stop requested during start', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    let acquired!: (status: 'started') => void;
    const startFullCaptureSession = vi.fn(() => new Promise<'started'>((resolve) => {
      acquired = resolve;
    }));
    const stopFullCapture = vi.fn().mockResolvedValue(undefined);
    let focus = 'A';
    const snapshot = vi.fn(async (): Promise<TargetSnapshot> => ({
      appName: 'Notes', appPid: 42, capturedAt: 1, elementId: focus,
      elementRole: 'AXTextField', insertable: true, kind: 'insertable', reason: null,
    }));
    const { result } = renderHook(() => useDogfoodCapture({
      captureApi: {
        ...stubCapture({ kind: 'idle' }),
        startFullCaptureSession,
        stopFullCapture,
      },
      clipboard: clipboard(),
      createModelStore: () => store,
      deliveryPlatform: createStubDeliveryAdapter({ clipboard: clipboard(), snapshot }),
      modelId: 'whisper-tiny.en',
    }));

    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(startFullCaptureSession).toHaveBeenCalledOnce());
    expect(result.current.phase).not.toBe('recording');
    focus = 'B';
    await act(async () => { await result.current.stop(); });
    focus = 'C';
    acquired('started');
    await act(async () => { await start; });
    expect(stopFullCapture).toHaveBeenCalledTimes(2);
    expect(snapshot).not.toHaveBeenCalled();
    expect(result.current.intendedTarget).toBeNull();
  });

  it('keeps dictating without Escape-cancel when the cancel tap cannot arm', async () => {
    const arm = vi.spyOn(cancelScopeModule, 'beginCancelScope')
      .mockRejectedValueOnce(new Error('Escape cancellation unavailable [cancel-tap-create-failed].'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const dogfood = vi.fn(mockDogfoodSuccess);
    let captureState: CaptureState = { kind: 'idle' };
    const { result, rerender } = renderHook(
      ({ state }: { state: CaptureState }) => useDogfoodCapture({
        captureApi: {
          ...stubCapture(state),
          startFullCaptureSession: async () => {
            captureState = { device: 'Mic', generation: 1, kind: 'active', request_id: 'full-1' };
            return 'started';
          },
          stopFullCapture: async () => {
            captureState = {
              audio: { duration_ms: 900, id: 'pcm-notap-1', sample_rate_hz: 16_000 },
              kind: 'stopped',
            };
          },
        },
        clipboard: clipboard(),
        createModelStore: () => store,
        dogfood: dogfood as never,
        modelId: 'whisper-tiny.en',
      }),
      { initialProps: { state: captureState } },
    );
    try {
      await act(async () => { await result.current.start(); });
      rerender({ state: captureState });
      expect(result.current.phase).toBe('recording');
      expect(result.current.scopeReady).toBe(false);
      // The HUD (waveform) still shows; only Escape-cancel is unavailable.
      expect(result.current.hudReady).toBe(true);
      expect(warn).toHaveBeenCalled();
      await act(async () => { await result.current.stop(); });
      rerender({ state: captureState });
      await waitFor(() => expect(result.current.phase).toBe('success'));
      expect(dogfood).toHaveBeenCalledOnce();
    } finally {
      arm.mockRestore();
      warn.mockRestore();
    }
  });

  it('auto-runs dogfoodTranscribeAndCopy after clean stop with audio', async () => {
    const clip = clipboard();
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');

    const dogfood = vi.fn(mockDogfoodSuccess);

    let captureState: CaptureState = { kind: 'idle' };
    const startFullCaptureSession = vi.fn(async () => {
      captureState = {
        device: 'Mic',
        generation: 1,
        kind: 'active',
        request_id: 'full-1',
      };
    });
    const stopFullCapture = vi.fn(async () => {
      captureState = {
        audio: {
          duration_ms: 900,
          id: 'pcm-dogfood-1',
          sample_rate_hz: 16_000,
        },
        kind: 'stopped',
      };
    });

    const { result, rerender } = renderHook(
      ({ state }: { state: CaptureState }) => useDogfoodCapture({
        captureApi: {
          ...stubCapture(state),
          startFullCaptureSession: async () => {
            await startFullCaptureSession();
            return 'started';
          },
          stopFullCapture: async () => {
            await stopFullCapture();
          },
        },
        clipboard: clip,
        createModelStore: () => store,
        dogfood: dogfood as never,
        modelId: 'whisper-tiny.en',
      }),
      { initialProps: { state: captureState } },
    );

    await act(async () => {
      await result.current.start();
    });
    rerender({ state: captureState });
    expect(result.current.phase).toBe('recording');
    expect(startFullCaptureSession).toHaveBeenCalledOnce();

    await act(async () => {
      await result.current.stop();
    });
    rerender({ state: captureState });

    await waitFor(() => expect(dogfood).toHaveBeenCalledOnce());
    expect(dogfood).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.objectContaining({ id: 'pcm-dogfood-1' }),
        modelId: 'whisper-tiny.en',
      }),
    );
    await waitFor(() => expect(result.current.phase).toBe('success'));
    expect(result.current.transcript?.text).toBeTruthy();
    expect(result.current.message).toMatch(/^Copied/i);
  });

  it('handles each stopped audio ID once across sessions', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const dogfood = vi.fn(mockDogfoodSuccess);
    const stopped: CaptureState = {
      audio: {
        duration_ms: 100,
        id: 'same-stopped-event',
        sample_rate_hz: 16_000,
      },
      kind: 'stopped',
    };
    const { rerender, result } = renderHook(
      ({ state }: { state: CaptureState }) => useDogfoodCapture({
        captureApi: stubCapture(state),
        clipboard: clipboard(),
        createModelStore: () => store,
        dogfood: dogfood as never,
        modelId: 'whisper-tiny.en',
      }),
      { initialProps: { state: { kind: 'idle' } as CaptureState } },
    );

    await act(async () => { await result.current.start(); });
    rerender({ state: stopped });
    await waitFor(() => expect(dogfood).toHaveBeenCalledOnce());
    rerender({ state: { kind: 'idle' } });
    rerender({ state: stopped });
    await Promise.resolve();
    expect(dogfood).toHaveBeenCalledOnce();
  });

  it('uses admission-time settings after later settings change', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const dogfood = vi.fn(mockDogfoodSuccess);
    let state: CaptureState = { kind: 'idle' };
    const captureApi = () => ({
      ...stubCapture(state),
      startFullCaptureSession: vi.fn().mockResolvedValue('started' as const),
      stopFullCapture: vi.fn(async () => {
        state = {
          audio: {
            duration_ms: 100,
            id: 'snapshot',
            sample_rate_hz: 16_000,
          },
          kind: 'stopped' as const,
        };
      }),
    });
    const initialProps: {
      current: CaptureState;
      style: 'casual' | 'formal';
    } = { current: state, style: 'formal' };
    const { rerender, result } = renderHook(
      ({ current, style }: {
        current: CaptureState;
        style: 'casual' | 'formal';
      }) => useDogfoodCapture({
        captureApi: { ...captureApi(), captureState: current },
        clipboard: clipboard(),
        clipboardFallback: style === 'formal',
        cleanupEnabled: true,
        cleanupModelId: 'qwen3-0.6b-q4-k-m',
        createModelStore: () => store,
        dictionary: [style === 'formal' ? 'Voxloom' : 'Changed'],
        dogfood: dogfood as never,
        modelId: style === 'formal'
          ? 'whisper-tiny.en'
          : 'whisper-base.en',
        style,
      }),
      { initialProps },
    );

    await act(async () => { await result.current.start(); });
    rerender({ current: state, style: 'casual' });
    await act(async () => { await result.current.stop(); });
    rerender({ current: state, style: 'casual' });

    await waitFor(() => expect(dogfood).toHaveBeenCalledOnce());
    expect(dogfood).toHaveBeenCalledWith(expect.objectContaining({
      cleanup: expect.objectContaining({
        snapshot: expect.objectContaining({
          dictionary: ['Voxloom'],
          style: 'formal',
        }),
      }),
      clipboardFallback: true,
      modelId: 'whisper-tiny.en',
    }));
  });

  it('surfaces transcript + warning toast when Copy soft-fails', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const toast = vi.fn();

    const dogfood = vi.fn(async (): Promise<DogfoodResult> => ({
      copied: false,
      copyWarning: 'NotAllowedError',
      delivery: deliveryOutcome('failed', 'still here', 'Failed — NotAllowedError'),
      transcript: { language: 'en', text: 'still here' },
    }));

    const stoppedState: CaptureState = {
      audio: {
        duration_ms: 500,
        id: 'pcm-copy-fail',
        sample_rate_hz: 16_000,
      },
      kind: 'stopped',
    };

    const { rerender, result } = renderHook(
      ({ state }: { state: CaptureState }) => useDogfoodCapture({
        captureApi: stubCapture(state),
        clipboard: clipboard(),
        createModelStore: () => store,
        dogfood: dogfood as never,
        modelId: 'whisper-tiny.en',
        onToast: toast,
      }),
      { initialProps: { state: { kind: 'idle' } as CaptureState } },
    );

    await act(async () => { await result.current.start(); });
    rerender({ state: stoppedState });

    await waitFor(() => expect(result.current.phase).toBe('success'));
    expect(result.current.transcript?.text).toBe('still here');
    expect(result.current.message).toMatch(/^Failed/i);
    expect(result.current.message).toMatch(/NotAllowedError/);
    expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/^Failed/i),
    );
  });

  it('errors clearly when the selected model is not downloaded', async () => {
    const store = createMockSttModelStore();
    const dogfood = vi.fn();
    const toast = vi.fn();

    const { result } = renderHook(() => useDogfoodCapture({
      captureApi: stubCapture({ kind: 'idle' }),
      clipboard: clipboard(),
      createModelStore: () => store,
      dogfood: dogfood as never,
      modelId: 'whisper-tiny.en',
      onToast: toast,
    }));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.phase).toBe('error');
    const expected =
      'Model “whisper-tiny.en” is not downloaded (status: missing). '
      + 'Download the selected model in Settings first.';
    expect(result.current.message).toBe(expected);
    expect(toast).toHaveBeenCalledWith(expected);
    expect(dogfood).not.toHaveBeenCalled();
  });

  it('stops audio without any target lookup', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const order: string[] = [];
    const status = store.status.bind(store);
    store.status = vi.fn(async (id: string) => {
      order.push('model');
      return status(id);
    }) as typeof store.status;
    const intended: TargetSnapshot = {
      appName: 'Brave',
      appPid: 7,
      capturedAt: 1,
      elementId: '7:AXTextField:',
      elementRole: 'AXTextField',
      insertable: true,
      kind: 'insertable',
      reason: null,
    };
    const platform: DeliveryPlatformAdapter = {
      clipboardRead: vi.fn().mockResolvedValue({ ok: true, text: '' }),
      clipboardRestore: vi.fn(),
      clipboardWrite: vi.fn(),
      insertText: vi.fn(),
      snapshotTarget: vi.fn(async () => {
        order.push('snapshot');
        return intended;
      }),
      validateTarget: vi.fn().mockResolvedValue(intended),
    };
    const { result } = renderHook(() => useDogfoodCapture({
      captureApi: stubCapture({ kind: 'idle' }),
      clipboard: clipboard(),
      createModelStore: () => store,
      deliveryPlatform: platform,
      dogfood: vi.fn() as never,
      modelId: 'whisper-tiny.en',
    }));
    await act(async () => {
      await result.current.start();
    });
    expect(order).toEqual(['model']);
    expect(result.current.intendedTarget).toBeNull();
    const targetB = { ...intended, elementId: 'field-B' };
    vi.mocked(platform.snapshotTarget).mockImplementation(async () => {
      order.push('snapshot-B');
      return targetB;
    });
    await act(async () => { await result.current.stop(); });
    expect(order).toEqual(['model']);
    expect(result.current.intendedTarget).toBeNull();
  });

  it('cancel discards without calling dogfood STT', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const dogfood = vi.fn();
    let captureState: CaptureState = { kind: 'idle' };
    const cancelActiveCapture = vi.fn(() => {
      captureState = { kind: 'cancelled' };
    });
    const startFullCaptureSession = vi.fn(async () => {
      captureState = {
        device: 'Mic',
        generation: 1,
        kind: 'active',
        request_id: 'full-2',
      };
      return 'started' as const;
    });

    const { result, rerender } = renderHook(
      ({ state }: { state: CaptureState }) => useDogfoodCapture({
        captureApi: {
          ...stubCapture(state),
          cancelActiveCapture,
          startFullCaptureSession,
        },
        clipboard: clipboard(),
        createModelStore: () => store,
        dogfood: dogfood as never,
        modelId: 'whisper-tiny.en',
      }),
      { initialProps: { state: captureState } },
    );

    await act(async () => {
      await result.current.start();
    });
    rerender({ state: captureState });

    act(() => {
      result.current.cancel();
    });
    rerender({ state: captureState });

    expect(cancelActiveCapture).toHaveBeenCalledOnce();
    expect(dogfood).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('cancelled');
  });

  it('does not tombstone disabled cleanup across a hook remount', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const cleanupEngine = {
      acquire: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockResolvedValue('cleaned'),
    };
    const first = renderHook(() => useDogfoodCapture({
      captureApi: stubCapture({ kind: 'idle' }),
      cleanupEnabled: false,
      cleanupEngine,
      clipboard: clipboard(),
      createModelStore: () => store,
      modelId: 'whisper-tiny.en',
    }));
    await act(async () => { await first.result.current.start(); });
    act(() => { first.result.current.cancel(); });
    await waitFor(() => expect(cleanupEngine.release).toHaveBeenCalled());
    const releasedId = cleanupEngine.release.mock.calls[0]?.[0];
    expect(cleanupEngine.cancel).not.toHaveBeenCalled();
    first.unmount();

    const second = renderHook(() => useDogfoodCapture({
      captureApi: stubCapture({ kind: 'idle' }),
      cleanupEnabled: true,
      cleanupEngine,
      cleanupModelId: 'qwen3-0.6b-q4-k-m',
      clipboard: clipboard(),
      createModelStore: () => store,
      modelId: 'whisper-tiny.en',
    }));
    await act(async () => { await second.result.current.start(); });
    const acquiredId = cleanupEngine.acquire.mock.calls[0]?.[0];
    expect(acquiredId).toBeTruthy();
    expect(acquiredId).not.toBe(releasedId);
    act(() => { second.result.current.cancel(); });
    await waitFor(() => {
      expect(cleanupEngine.release).toHaveBeenCalledWith(acquiredId);
    });
    second.unmount();
  });

  it('a stale session\'s STT completion does not clobber a newer session\'s phase', async () => {
    // Hold 1 stops → transcribing (slow). User starts hold 2 before STT
    // resolves. Session 1's completion may still record delivery evidence
    // but must not flip phase "recording" → "success" mid-session-2.
    const clip = clipboard();
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    let resolveDogfood: ((r: DogfoodResult) => void) | null = null;
    const dogfood = vi.fn(() => new Promise<DogfoodResult>((resolve) => {
      resolveDogfood = resolve;
    }));
    const onHistoryRecord = vi.fn();
    const onToast = vi.fn();

    let captureState: CaptureState = { kind: 'idle' };
    let generation = 0;
    const startFullCaptureSession = vi.fn(async () => {
      generation += 1;
      captureState = {
        device: 'Mic',
        generation,
        kind: 'active',
        request_id: `full-${generation}`,
      };
      return 'started' as const;
    });
    const stopFullCapture = vi.fn(async () => {
      captureState = {
        audio: {
          duration_ms: 900,
          id: `pcm-${generation}`,
          sample_rate_hz: 16_000,
        },
        kind: 'stopped',
      };
    });

    const { result, rerender } = renderHook(
      ({ state }: { state: CaptureState }) => useDogfoodCapture({
        captureApi: {
          ...stubCapture(state),
          startFullCaptureSession,
          stopFullCapture,
        },
        clipboard: clip,
        createModelStore: () => store,
        dogfood: dogfood as never,
        modelId: 'whisper-tiny.en',
        onHistoryRecord,
        onToast,
      }),
      { initialProps: { state: captureState } },
    );

    // Session 1: start → stop → transcribing (dogfood pending).
    await act(async () => {
      await result.current.start();
    });
    rerender({ state: captureState });
    await act(async () => {
      await result.current.stop();
    });
    rerender({ state: captureState });
    await waitFor(() => expect(dogfood).toHaveBeenCalledOnce());
    expect(result.current.phase).toBe('transcribing');

    // Session 2 starts while session 1 STT is still in flight.
    await act(async () => {
      await result.current.start();
    });
    rerender({ state: captureState });
    expect(result.current.phase).toBe('recording');

    // Session 1 completes late.
    const late = await mockDogfoodSuccess({
      audio: { duration_ms: 900, id: 'pcm-1', sample_rate_hz: 16_000 },
      modelId: 'whisper-tiny.en',
    });
    await act(async () => {
      resolveDogfood?.(late);
      await Promise.resolve();
    });
    rerender({ state: captureState });

    // Still recording session 2; delivery evidence still surfaced.
    expect(result.current.phase).toBe('recording');
    await waitFor(() => expect(onHistoryRecord).toHaveBeenCalledOnce());
    expect(onToast).toHaveBeenCalledWith(late.delivery.message);
  });

  it('keeps jobs FIFO through history and rejects a third capture', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const events: string[] = [];
    const resolvers: Array<(result: DogfoodResult) => void> = [];
    const dogfood = vi.fn(() => new Promise<DogfoodResult>((resolve) => {
      events.push(`dogfood-${resolvers.length + 1}`);
      resolvers.push(resolve);
    }));
    const onHistoryRecord = vi.fn((record: DictationRecord) => {
      events.push(`history-${record.id}`);
    });
    let state: CaptureState = { kind: 'idle' };
    let generation = 0;
    const startFullCaptureSession = vi.fn(async () => {
      generation += 1;
      state = {
        device: 'Mic',
        generation,
        kind: 'active',
        request_id: `full-${generation}`,
      };
      return 'started' as const;
    });
    const stopFullCapture = vi.fn(async () => {
      state = {
        audio: {
          duration_ms: 100,
          id: `fifo-${generation}`,
          sample_rate_hz: 16_000,
        },
        kind: 'stopped',
      };
    });
    const { rerender, result } = renderHook(
      ({ captureState }: { captureState: CaptureState }) =>
        useDogfoodCapture({
          captureApi: {
            ...stubCapture(captureState),
            startFullCaptureSession,
            stopFullCapture,
          },
          clipboard: clipboard(),
          createModelStore: () => store,
          dogfood: dogfood as never,
          modelId: 'whisper-tiny.en',
          onHistoryRecord,
        }),
      { initialProps: { captureState: state } },
    );

    await act(async () => { await result.current.start(); });
    rerender({ captureState: state });
    await act(async () => { await result.current.stop(); });
    rerender({ captureState: state });
    await waitFor(() => expect(dogfood).toHaveBeenCalledOnce());

    await act(async () => { await result.current.start(); });
    rerender({ captureState: state });
    await act(async () => { await result.current.stop(); });
    rerender({ captureState: state });
    expect(dogfood).toHaveBeenCalledOnce();

    await act(async () => { await result.current.start(); });
    expect(startFullCaptureSession).toHaveBeenCalledTimes(2);

    const first = await mockDogfoodSuccess({
      audio: { duration_ms: 100, id: 'fifo-1', sample_rate_hz: 16_000 },
      modelId: 'whisper-tiny.en',
    });
    await act(async () => { resolvers[0]?.(first); });
    await waitFor(() => expect(dogfood).toHaveBeenCalledTimes(2));
    expect(events.slice(0, 3)).toEqual([
      'dogfood-1',
      'history-dogfood-fifo-1',
      'dogfood-2',
    ]);

    const second = await mockDogfoodSuccess({
      audio: { duration_ms: 100, id: 'fifo-2', sample_rate_hz: 16_000 },
      modelId: 'whisper-tiny.en',
    });
    await act(async () => { resolvers[1]?.(second); });
    await waitFor(() => expect(onHistoryRecord).toHaveBeenCalledTimes(2));
    expect(events.at(-1)).toBe('history-dogfood-fifo-2');
  });

  it('releases cancelled queued B without releasing active A or running B', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const cleanupEngine = {
      acquire: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
      run: vi.fn(),
    };
    let finishA!: (result: DogfoodResult) => void;
    const dogfood = vi.fn(() => new Promise<DogfoodResult>((resolve) => {
      finishA = resolve;
    }));
    const history = vi.fn();
    const { result, rerender } = renderHook(
      ({ state }: { state: CaptureState }) => useDogfoodCapture({
        captureApi: stubCapture(state),
        cleanupEnabled: true,
        cleanupEngine,
        cleanupModelId: 'qwen3-0.6b-q4-k-m',
        clipboard: clipboard(),
        createModelStore: () => store,
        dogfood,
        modelId: 'whisper-tiny.en',
        onHistoryRecord: history,
      }),
      { initialProps: { state: { kind: 'idle' } as CaptureState } },
    );
    const stopped = (id: string): CaptureState => ({
      audio: { duration_ms: 100, id, sample_rate_hz: 16_000 },
      kind: 'stopped',
    });

    await act(async () => { await result.current.start(); });
    const idA = cleanupEngine.acquire.mock.calls[0][0];
    rerender({ state: stopped('active-a') });
    await waitFor(() => expect(dogfood).toHaveBeenCalledOnce());
    rerender({ state: { kind: 'idle' } });
    await act(async () => { await result.current.start(); });
    const idB = cleanupEngine.acquire.mock.calls[1][0];
    rerender({ state: stopped('queued-b') });
    expect(result.current.phase).toBe('queued');
    act(() => { result.current.cancel(); });
    await waitFor(() => {
      expect(cleanupEngine.release).toHaveBeenCalledWith(idB);
    });
    expect(cleanupEngine.release).not.toHaveBeenCalledWith(idA);
    expect(dogfood).toHaveBeenCalledOnce();
    expect(history).not.toHaveBeenCalled();

    // Cancellation frees B's reservation while A still owns its descriptor.
    rerender({ state: { kind: 'idle' } });
    await act(async () => { await result.current.start(); });
    expect(cleanupEngine.acquire).toHaveBeenCalledTimes(3);
    act(() => { result.current.cancel(); });
    await act(async () => {
      finishA(await mockDogfoodSuccess({
        audio: { duration_ms: 100, id: 'active-a', sample_rate_hz: 16_000 },
        modelId: 'whisper-tiny.en',
      }));
    });
    await waitFor(() => {
      expect(cleanupEngine.release.mock.calls.filter(([id]) => id === idA))
        .toHaveLength(1);
    });
    expect(cleanupEngine.release.mock.calls.filter(([id]) => id === idB))
      .toHaveLength(1);
    expect(dogfood).toHaveBeenCalledOnce();
    expect(history).toHaveBeenCalledOnce();
    expect(history.mock.calls[0][0].id).toBe('dogfood-active-a');
  });

  it('disposes its native owner and prevents late capture start on unmount during acquire', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    let finishAcquire!: () => void;
    const cleanupEngine = {
      acquire: vi.fn(() => new Promise<void>((resolve) => { finishAcquire = resolve; })),
      cancel: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
      run: vi.fn(),
    };
    const captureApi = stubCapture({ kind: 'idle' });
    const { result, unmount } = renderHook(() => useDogfoodCapture({
      captureApi, cleanupEngine, cleanupEnabled: true,
      cleanupModelId: 'qwen3-0.6b-q4-k-m', clipboard: clipboard(),
      createModelStore: () => store, modelId: 'whisper-tiny.en',
    }));
    let starting!: Promise<void>;
    act(() => { starting = result.current.start(); });
    await waitFor(() => expect(cleanupEngine.acquire).toHaveBeenCalledOnce());
    unmount();
    expect(cleanupEngine.dispose).toHaveBeenCalledOnce();
    await act(async () => { finishAcquire(); await starting; });
    expect(captureApi.startFullCaptureSession).not.toHaveBeenCalled();
    expect(cleanupEngine.release).toHaveBeenCalled();
  });

  it('aborts active and queued jobs on unmount without executing the queued job', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const cleanupEngine = {
      acquire: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
      run: vi.fn(),
    };
    let rejectRun!: (error: Error) => void;
    const dogfood = vi.fn<(input: DogfoodTranscribeOptions) => Promise<DogfoodResult>>(
      () => new Promise<DogfoodResult>((_resolve, reject) => { rejectRun = reject; }),
    );
    const history = vi.fn();
    const { result, rerender, unmount } = renderHook(
      ({ state }: { state: CaptureState }) => useDogfoodCapture({
        captureApi: stubCapture(state), cleanupEngine, cleanupEnabled: true,
        cleanupModelId: 'qwen3-0.6b-q4-k-m', clipboard: clipboard(),
        createModelStore: () => store, dogfood, modelId: 'whisper-tiny.en',
        onHistoryRecord: history,
      }),
      { initialProps: { state: { kind: 'idle' } as CaptureState } },
    );
    const stopped = (id: string): CaptureState => ({
      audio: { duration_ms: 100, id, sample_rate_hz: 16_000 }, kind: 'stopped',
    });
    await act(async () => { await result.current.start(); });
    rerender({ state: stopped('active-unmount') });
    await waitFor(() => expect(dogfood).toHaveBeenCalledOnce());
    const signal = dogfood.mock.calls[0][0].cleanup?.signal;
    rerender({ state: { kind: 'idle' } });
    await act(async () => { await result.current.start(); });
    const queuedId = cleanupEngine.acquire.mock.calls[1][0];
    rerender({ state: stopped('queued-unmount') });
    unmount();
    expect(signal?.aborted).toBe(true);
    expect(cleanupEngine.dispose).toHaveBeenCalledOnce();
    await waitFor(() => expect(cleanupEngine.release).toHaveBeenCalledWith(queuedId));
    await act(async () => { rejectRun(new DOMException('Cancelled', 'AbortError')); });
    expect(dogfood).toHaveBeenCalledOnce();
    expect(history).not.toHaveBeenCalled();
  });

  it('keeps active cleanup ownership until cancelled execution settles', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const cleanupEngine = {
      acquire: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
      run: vi.fn(),
    };
    let rejectRun!: (error: Error) => void;
    const dogfood = vi.fn(() => new Promise<DogfoodResult>((_yes, no) => {
      rejectRun = no;
    }));
    const { result, rerender } = renderHook(
      ({ state }: { state: CaptureState }) => useDogfoodCapture({
        captureApi: stubCapture(state),
        cleanupEnabled: true,
        cleanupEngine,
        cleanupModelId: 'qwen3-0.6b-q4-k-m',
        clipboard: clipboard(),
        createModelStore: () => store,
        dogfood,
        modelId: 'whisper-tiny.en',
      }),
      { initialProps: { state: { kind: 'idle' } as CaptureState } },
    );
    await act(async () => { await result.current.start(); });
    rerender({ state: {
      audio: { duration_ms: 100, id: 'active', sample_rate_hz: 16_000 },
      kind: 'stopped',
    } });
    await waitFor(() => expect(dogfood).toHaveBeenCalledOnce());
    act(() => { result.current.cancel(); });
    expect(cleanupEngine.release).not.toHaveBeenCalled();
    await act(async () => {
      rejectRun(new DOMException('Cancelled', 'AbortError'));
    });
    expect(cleanupEngine.release).toHaveBeenCalledExactlyOnceWith(
      cleanupEngine.acquire.mock.calls[0][0],
    );
  });

  it('appends a copied history record after successful dogfood', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const onHistoryRecord = vi.fn();
    const dogfood = vi.fn(mockDogfoodSuccess);

    const stoppedState: CaptureState = {
      audio: {
        duration_ms: 2_400,
        id: 'pcm-hist-ok',
        sample_rate_hz: 16_000,
      },
      kind: 'stopped',
    };

    const { rerender, result } = renderHook(
      ({ state }: { state: CaptureState }) => useDogfoodCapture({
        captureApi: stubCapture(state),
        clipboard: clipboard(),
        createModelStore: () => store,
        dogfood: dogfood as never,
        modelId: 'whisper-tiny.en',
        now: () => 42_000,
        onHistoryRecord,
        style: 'casual',
      }),
      { initialProps: { state: { kind: 'idle' } as CaptureState } },
    );

    await act(async () => { await result.current.start(); });
    rerender({ state: stoppedState });

    await waitFor(() => expect(result.current.phase).toBe('success'));
    expect(onHistoryRecord).toHaveBeenCalledOnce();
    expect(onHistoryRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        durationSeconds: 2,
        id: 'dogfood-pcm-hist-ok',
        model: 'whisper-tiny.en',
        status: 'copied',
        style: 'casual',
        text: expect.any(String),
      }),
    );
    expect(onHistoryRecord.mock.calls[0][0].text.trim().length).toBeGreaterThan(0);
  });

  it('appends failed history when Copy soft-fails with transcript text', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const onHistoryRecord = vi.fn();

    const dogfood = vi.fn(async (): Promise<DogfoodResult> => ({
      copied: false,
      copyWarning: 'NotAllowedError',
      delivery: deliveryOutcome('failed', 'soft fail text', 'Failed — NotAllowedError'),
      transcript: { language: 'en', text: 'soft fail text' },
    }));

    const stoppedState: CaptureState = {
      audio: {
        duration_ms: 800,
        id: 'pcm-hist-soft',
        sample_rate_hz: 16_000,
      },
      kind: 'stopped',
    };

    const { rerender, result } = renderHook(
      ({ state }: { state: CaptureState }) => useDogfoodCapture({
        captureApi: stubCapture(state),
        clipboard: clipboard(),
        createModelStore: () => store,
        dogfood: dogfood as never,
        modelId: 'whisper-tiny.en',
        now: () => 99_000,
        onHistoryRecord,
        style: 'formal',
      }),
      { initialProps: { state: { kind: 'idle' } as CaptureState } },
    );

    await act(async () => { await result.current.start(); });
    rerender({ state: stoppedState });

    await waitFor(() => expect(result.current.phase).toBe('success'));
    expect(onHistoryRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'dogfood-pcm-hist-soft',
        status: 'failed',
        text: 'soft fail text',
      }),
    );
  });

  it('retains acquire failure and immutable model selection through raw delivery', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const onHistoryRecord = vi.fn();
    const onToast = vi.fn();
    const cleanupEngine = {
      acquire: vi.fn().mockRejectedValue(new CleanupEngineError('runtime-error', 'descriptor capacity full')),
      cancel: vi.fn(), release: vi.fn(), run: vi.fn(),
    };
    const dogfood = vi.fn((options: DogfoodTranscribeOptions) => dogfoodTranscribeAndCopy({
      ...options, createEngine: (modelId) => createMockSttEngine({ modelId, transcriptText: 'raw' }),
    }));
    const { result, rerender } = renderHook(
      ({ state }: { state: CaptureState }) => useDogfoodCapture({
        captureApi: stubCapture(state), cleanupEnabled: true, cleanupEngine,
        cleanupModelId: 'qwen3-0.6b-q4-k-m', clipboard: clipboard(),
        createModelStore: () => store, dogfood, modelId: 'whisper-tiny.en',
        onHistoryRecord, onToast,
      }), { initialProps: { state: { kind: 'idle' } as CaptureState } },
    );
    await act(async () => { await result.current.start(); });
    rerender({ state: { kind: 'stopped', audio: {
      duration_ms: 100, id: 'acquire-failure', sample_rate_hz: 16_000,
    } } });
    await waitFor(() => expect(onHistoryRecord).toHaveBeenCalledOnce());
    expect(dogfood.mock.calls[0][0].cleanup?.snapshot.modelId).toBe('qwen3-0.6b-q4-k-m');
    expect(onHistoryRecord.mock.calls[0][0].cleanup).toMatchObject({
      status: 'fallback', reason: 'runtime-error', modelId: null, modelDigest: null,
    });
    expect(cleanupEngine.run).not.toHaveBeenCalled();
    expect(cleanupEngine.release).toHaveBeenCalledOnce();
    expect(onToast).not.toHaveBeenCalledWith('Cleaning up locally…');
  });

  it.each([true, false])('settles silent capture without writes, cleanup=%s', async (enabled) => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const onHistoryRecord = vi.fn();
    const clip = clipboard();
    const cleanupEngine = {
      acquire: vi.fn(), cancel: vi.fn(), release: vi.fn(),
      run: vi.fn().mockResolvedValue('Invented speech.'),
    };
    const platform: DeliveryPlatformAdapter = {
      clipboardRead: vi.fn(), clipboardRestore: vi.fn(),
      clipboardWrite: vi.fn(), insertText: vi.fn(),
      snapshotTarget: vi.fn().mockResolvedValue(null), validateTarget: vi.fn(),
    };
    const { rerender, result } = renderHook(
      ({ state }: { state: CaptureState }) => useDogfoodCapture({
        captureApi: stubCapture(state),
        cleanupEnabled: enabled,
        cleanupEngine,
        cleanupModelId: 'qwen3-0.6b-q4-k-m',
        clipboard: clip,
        createModelStore: () => store,
        deliveryPlatform: platform,
        dogfood: (options) => dogfoodTranscribeAndCopy({
          ...options,
          createEngine: (modelId) => createMockSttEngine({
            modelId, transcriptText: ' \n\t ',
          }),
        }),
        modelId: 'whisper-tiny.en',
        onHistoryRecord,
      }),
      { initialProps: { state: { kind: 'idle' } as CaptureState } },
    );
    await act(async () => { await result.current.start(); });
    rerender({ state: { kind: 'stopped', audio: {
      duration_ms: 100, id: 'silent-integration', sample_rate_hz: 16_000,
    } } });
    await waitFor(() => expect(result.current.message).toMatch(/no speech/i));
    expect(result.current.phase).toBe('idle');
    expect(cleanupEngine.release).toHaveBeenCalledOnce();
    expect(cleanupEngine.run).not.toHaveBeenCalled();
    expect(platform.validateTarget).not.toHaveBeenCalled();
    expect(platform.insertText).not.toHaveBeenCalled();
    expect(platform.clipboardWrite).not.toHaveBeenCalled();
    expect(clip.copy).not.toHaveBeenCalled();
    expect(onHistoryRecord).not.toHaveBeenCalled();
    await act(async () => { await result.current.start(); });
    expect(result.current.phase).toBe('recording');
  });

  it.each([true, false])('keeps cancelled failed-write history, fallback=%s', async (fallback) => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const onHistoryRecord = vi.fn();
    const onToast = vi.fn();
    let rejectInsert!: (error: Error) => void;
    const intended: TargetSnapshot = {
      appName: 'Test', appPid: 42, capturedAt: 1,
      elementId: 'test', elementRole: 'AXTextArea',
      insertable: true, kind: 'insertable', reason: null,
    };
    const platform: DeliveryPlatformAdapter = {
      clipboardRead: vi.fn(), clipboardRestore: vi.fn(), clipboardWrite: vi.fn(),
      insertText: vi.fn(() => new Promise<void>((_resolve, reject) => {
        rejectInsert = reject;
      })),
      snapshotTarget: vi.fn().mockResolvedValue(intended),
      validateTarget: vi.fn().mockResolvedValue(intended),
    };
    const { rerender, result } = renderHook(
      ({ state }: { state: CaptureState }) => useDogfoodCapture({
        captureApi: stubCapture(state),
        clipboard: clipboard(), clipboardFallback: fallback,
        createModelStore: () => store,
        deliveryPlatform: platform,
        dogfood: (options) => dogfoodTranscribeAndCopy({
          ...options,
          createEngine: (modelId) => createMockSttEngine({
            modelId, transcriptText: 'recover this',
          }),
        }),
        modelId: 'whisper-tiny.en', onHistoryRecord, onToast,
      }),
      { initialProps: { state: { kind: 'idle' } as CaptureState } },
    );
    await act(async () => { await result.current.start(); });
    rerender({ state: { kind: 'stopped', audio: {
      duration_ms: 100, id: 'cancel-write', sample_rate_hz: 16_000,
    } } });
    await waitFor(() => expect(platform.insertText).toHaveBeenCalledOnce());
    expect(result.current.phase).toBe('delivering');
    act(() => { result.current.cancel(); });
    await act(async () => { rejectInsert(new Error('AX original failure')); });
    await waitFor(() => expect(onHistoryRecord).toHaveBeenCalledOnce());
    expect(onHistoryRecord).toHaveBeenCalledWith(expect.objectContaining({
      text: 'recover this', rawText: 'recover this', status: 'failed',
    }));
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining('AX original failure'));
    expect(platform.clipboardWrite).not.toHaveBeenCalled();
  });

  it('does not append history for blank transcripts', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const onHistoryRecord = vi.fn();

    const dogfood = vi.fn(async (): Promise<DogfoodResult> => ({
      copied: true,
      delivery: deliveryOutcome('copied', '   '),
      transcript: { language: 'en', text: '   ' },
    }));

    const stoppedState: CaptureState = {
      audio: {
        duration_ms: 100,
        id: 'pcm-hist-blank',
        sample_rate_hz: 16_000,
      },
      kind: 'stopped',
    };

    const { rerender, result } = renderHook(
      ({ state }: { state: CaptureState }) => useDogfoodCapture({
        captureApi: stubCapture(state),
        clipboard: clipboard(),
        createModelStore: () => store,
        dogfood: dogfood as never,
        modelId: 'whisper-tiny.en',
        onHistoryRecord,
      }),
      { initialProps: { state: { kind: 'idle' } as CaptureState } },
    );

    await act(async () => { await result.current.start(); });
    rerender({ state: stoppedState });

    await waitFor(() => expect(result.current.phase).toBe('success'));
    expect(onHistoryRecord).not.toHaveBeenCalled();
  });

  it('does not append history on cancel', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const onHistoryRecord = vi.fn();
    const dogfood = vi.fn();
    let captureState: CaptureState = { kind: 'idle' };
    const cancelActiveCapture = vi.fn(() => {
      captureState = { kind: 'cancelled' };
    });
    const startFullCaptureSession = vi.fn(async () => {
      captureState = {
        device: 'Mic',
        generation: 1,
        kind: 'active',
        request_id: 'full-hist-cancel',
      };
      return 'started' as const;
    });

    const { result, rerender } = renderHook(
      ({ state }: { state: CaptureState }) => useDogfoodCapture({
        captureApi: {
          ...stubCapture(state),
          cancelActiveCapture,
          startFullCaptureSession,
        },
        clipboard: clipboard(),
        createModelStore: () => store,
        dogfood: dogfood as never,
        modelId: 'whisper-tiny.en',
        onHistoryRecord,
      }),
      { initialProps: { state: captureState } },
    );

    await act(async () => {
      await result.current.start();
    });
    rerender({ state: captureState });

    act(() => {
      result.current.cancel();
    });
    rerender({ state: captureState });

    expect(result.current.phase).toBe('cancelled');
    expect(onHistoryRecord).not.toHaveBeenCalled();
    expect(dogfood).not.toHaveBeenCalled();
  });

  it.each([
    { committed: false, expected: 0, started: false, status: 'failed' },
    { committed: false, expected: 1, started: true, status: 'failed' },
    { committed: true, expected: 1, started: true, status: 'inserted' },
  ] as const)(
    'guards delayed provenance history for write evidence %#',
    async ({ committed, expected, started, status }) => {
      const store = createMockSttModelStore();
      await store.download('whisper-tiny.en');
      let finishProvenance!: (value: CleanupProvenance) => void;
      const createProvenance = vi.fn(() =>
        new Promise<CleanupProvenance>((resolve) => {
          finishProvenance = resolve;
        }));
      const onHistoryRecord = vi.fn();
      const stopped: CaptureState = {
        audio: {
          duration_ms: 100,
          id: `provenance-${status}-${started}`,
          sample_rate_hz: 16_000,
        },
        kind: 'stopped',
      };
      const dogfood = vi.fn(async (): Promise<DogfoodResult> => ({
        copied: false,
        delivery: {
          ...deliveryOutcome(status, 'delayed provenance'),
          writeCommitted: committed,
          writeStarted: started,
        },
        transcript: { language: 'en', text: 'delayed provenance' },
      }));
      const { rerender, result } = renderHook(
        ({ state }: { state: CaptureState }) => useDogfoodCapture({
          captureApi: stubCapture(state),
          clipboard: clipboard(),
          createModelStore: () => store,
          createProvenance,
          dogfood: dogfood as never,
          modelId: 'whisper-tiny.en',
          onHistoryRecord,
        }),
        { initialProps: { state: { kind: 'idle' } as CaptureState } },
      );

      await act(async () => { await result.current.start(); });
      rerender({ state: stopped });
      await waitFor(() => expect(createProvenance).toHaveBeenCalledOnce());
      act(() => { result.current.cancel(); });
      await act(async () => {
        finishProvenance({
          dictionaryDigest: null,
          dictionaryVersion: 1,
          modelDigest: null,
          modelId: null,
          promptVersion: 'cleanup-v1',
          reason: null,
          status: 'skipped',
        });
      });
      await waitFor(() => expect(result.current.phase).toBe('cancelled'));
      expect(onHistoryRecord).toHaveBeenCalledTimes(expected);
    },
  );




  it.each([
    ['failed', false],
    ['copied', true],
  ] as const)('records a may-have-inserted %s delivery as Unverified, not Failed/Copied (Review #44)', async (status, copied) => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const onHistoryRecord = vi.fn();
    const dogfood = vi.fn(async (): Promise<DogfoodResult> => ({
      copied,
      delivery: { ...deliveryOutcome(status, 'maybe here'), mayHaveInserted: true },
      transcript: { language: 'en', text: 'maybe here' },
    }));
    const { result } = renderHook(() => useDogfoodCapture({
      captureApi: stubCapture({ audio: { duration_ms: 500, id: `pcm-maybe-${status}`, sample_rate_hz: 16_000 }, kind: 'stopped' }),
      clipboard: clipboard(),
      createModelStore: () => store,
      dogfood: dogfood as never,
      modelId: 'whisper-tiny.en',
      onHistoryRecord,
    }));
    await waitFor(() => expect(result.current.phase).toBe('success'));
    expect(onHistoryRecord).toHaveBeenCalledWith(expect.objectContaining({
      mayHaveInserted: { copied },
      status: 'unverified',
    }));
  });
});
