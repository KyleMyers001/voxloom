/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ClipboardAdapter } from '../../../src/services/clipboard';
import type { DeliveryPlatformAdapter, TargetSnapshot } from
  '../../../src/services/delivery';
import type { CaptureState } from '../../../src/services/capture/types';
import type { UseCaptureStateResult } from
  '../../../src/services/capture/useCaptureState';
import { dogfoodTranscribeAndCopy } from '../../../src/services/stt/dogfoodPath';
import { createStubDeliveryAdapter } from '../../../src/services/delivery';
import type { DogfoodResult } from '../../../src/services/stt/dogfoodPath';
import {
  createMockSttEngine,
  createMockSttModelStore,
} from '../../../src/services/stt/mockStt';
import { useDogfoodCapture } from
  '../../../src/services/stt/useDogfoodCapture';

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
    },
    transcript,
  };
}

describe('useDogfoodCapture', () => {
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

    const captureState: CaptureState = {
      audio: {
        duration_ms: 500,
        id: 'pcm-copy-fail',
        sample_rate_hz: 16_000,
      },
      kind: 'stopped',
    };

    const { result } = renderHook(() => useDogfoodCapture({
      captureApi: stubCapture(captureState),
      clipboard: clipboard(),
      createModelStore: () => store,
      dogfood: dogfood as never,
      modelId: 'whisper-tiny.en',
      onToast: toast,
    }));

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
    expect(result.current.message).toMatch(/not downloaded/i);
    expect(result.current.message).toMatch(/no silent download/i);
    expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/not downloaded/i),
    );
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
    expect(onHistoryRecord).toHaveBeenCalledOnce();
    expect(onToast).toHaveBeenCalledWith(late.delivery.message);
  });

  it('appends a copied history record after successful dogfood', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const onHistoryRecord = vi.fn();
    const dogfood = vi.fn(mockDogfoodSuccess);

    const captureState: CaptureState = {
      audio: {
        duration_ms: 2_400,
        id: 'pcm-hist-ok',
        sample_rate_hz: 16_000,
      },
      kind: 'stopped',
    };

    const { result } = renderHook(() => useDogfoodCapture({
      captureApi: stubCapture(captureState),
      clipboard: clipboard(),
      createModelStore: () => store,
      dogfood: dogfood as never,
      modelId: 'whisper-tiny.en',
      now: () => 42_000,
      onHistoryRecord,
      style: 'casual',
    }));

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

    const captureState: CaptureState = {
      audio: {
        duration_ms: 800,
        id: 'pcm-hist-soft',
        sample_rate_hz: 16_000,
      },
      kind: 'stopped',
    };

    const { result } = renderHook(() => useDogfoodCapture({
      captureApi: stubCapture(captureState),
      clipboard: clipboard(),
      createModelStore: () => store,
      dogfood: dogfood as never,
      modelId: 'whisper-tiny.en',
      now: () => 99_000,
      onHistoryRecord,
      style: 'formal',
    }));

    await waitFor(() => expect(result.current.phase).toBe('success'));
    expect(onHistoryRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'dogfood-pcm-hist-soft',
        status: 'failed',
        text: 'soft fail text',
      }),
    );
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

    const captureState: CaptureState = {
      audio: {
        duration_ms: 100,
        id: 'pcm-hist-blank',
        sample_rate_hz: 16_000,
      },
      kind: 'stopped',
    };

    const { result } = renderHook(() => useDogfoodCapture({
      captureApi: stubCapture(captureState),
      clipboard: clipboard(),
      createModelStore: () => store,
      dogfood: dogfood as never,
      modelId: 'whisper-tiny.en',
      onHistoryRecord,
    }));

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

