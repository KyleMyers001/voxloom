/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ClipboardAdapter } from '../../../src/services/clipboard';
import type { DeliveryPlatformAdapter, TargetSnapshot } from
  '../../../src/services/delivery';
import type { CaptureState } from '../../../src/services/capture/types';
import type { UseCaptureStateResult } from
  '../../../src/services/capture/useCaptureState';
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
    const { result } = renderHook(() => useDogfoodCapture({
      captureApi: {
        ...stubCapture({ kind: 'idle' }),
        startFullCaptureSession,
        stopFullCapture,
      },
      clipboard: clipboard(),
      createModelStore: () => store,
      modelId: 'whisper-tiny.en',
    }));

    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(startFullCaptureSession).toHaveBeenCalledOnce());
    expect(result.current.phase).not.toBe('recording');
    await act(async () => { await result.current.stop(); });
    acquired('started');
    await act(async () => { await start; });
    expect(stopFullCapture).toHaveBeenCalledTimes(2);
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

  it('snapshots the target before awaiting model validation', async () => {
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
    expect(order.slice(0, 2)).toEqual(['snapshot', 'model']);
    expect(result.current.intendedTarget).toEqual(intended);
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
    // resolves. Session 1's completion must still deliver + record history
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


  it('snapshots intended target at start and passes it to dogfood (no Voxloom focus required)', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');

    const intended: TargetSnapshot = {
      appName: 'Notes',
      appPid: 4242,
      capturedAt: 1_000,
      elementId: 'ax-notes-1',
      elementRole: 'AXTextArea',
      insertable: true,
      kind: 'insertable',
      reason: null,
    };
    const snapshotTarget = vi.fn().mockResolvedValue(intended);
    const platform: DeliveryPlatformAdapter = {
      clipboardRead: vi.fn().mockResolvedValue({ ok: true, text: '' }),
      clipboardRestore: vi.fn(),
      clipboardWrite: vi.fn(),
      insertText: vi.fn(),
      snapshotTarget,
      validateTarget: vi.fn().mockResolvedValue(intended),
    };

    const dogfood = vi.fn(async (): Promise<DogfoodResult> => ({
      copied: false,
      delivery: deliveryOutcome('inserted', 'hello notes', 'Inserted'),
      transcript: { language: 'en', text: 'hello notes' },
    }));

    let captureState: CaptureState = { kind: 'idle' };
    const startFullCaptureSession = vi.fn(async () => {
      // Capture starts *after* snapshot — proves order for gesture smoke.
      expect(snapshotTarget).toHaveBeenCalledOnce();
      captureState = {
        device: 'Mic',
        generation: 1,
        kind: 'active',
        request_id: 'full-snap',
      };
      return 'started' as const;
    });
    const stopFullCapture = vi.fn(async () => {
      captureState = {
        audio: {
          duration_ms: 700,
          id: 'pcm-snap-1',
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
        clipboard: clipboard(),
        createModelStore: () => store,
        deliveryPlatform: platform,
        dogfood: dogfood as never,
        modelId: 'whisper-tiny.en',
      }),
      { initialProps: { state: captureState } },
    );

    await act(async () => {
      await result.current.start();
    });
    expect(snapshotTarget).toHaveBeenCalledOnce();
    expect(result.current.intendedTarget).toEqual(intended);
    // start() does not activate any app — snapshot uses whatever was frontmost.
    expect(startFullCaptureSession).toHaveBeenCalledOnce();

    rerender({ state: captureState });
    await act(async () => {
      await result.current.stop();
    });
    rerender({ state: captureState });

    await waitFor(() => expect(dogfood).toHaveBeenCalledOnce());
    expect(dogfood).toHaveBeenCalledWith(
      expect.objectContaining({ intended }),
    );
    await waitFor(() => expect(result.current.phase).toBe('success'));
    expect(result.current.message).toMatch(/^Inserted/i);
  });

});
