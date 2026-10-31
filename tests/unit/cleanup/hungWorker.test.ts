/** @vitest-environment jsdom */
// BUS-16 #104 (QA P2): the real Tauri cleanup adapter with a mocked native
// side where `cleanup_run` never settles. The stage deadline must be an outer
// bound: raw text comes back at deadline + CANCEL_GRACE_MS whatever native
// `cleanup_cancel` does, and a late result is never used.
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptureState } from '../../../src/services/capture/types';
import type { UseCaptureStateResult } from '../../../src/services/capture/useCaptureState';
import { createStubDeliveryAdapter } from '../../../src/services/delivery';
import { dogfoodTranscribeAndCopy } from '../../../src/services/stt/dogfoodPath';
import { createMockSttEngine, createMockSttModelStore } from '../../../src/services/stt/mockStt';
import { useDogfoodCapture } from '../../../src/services/stt/useDogfoodCapture';
import { CANCEL_GRACE_MS, runCleanup } from '../../../src/services/cleanup/runCleanup';
import { createTauriCleanupEngine } from '../../../src/services/cleanup/tauriAdapter';
import { CLEANUP_MODEL_ID, CLEANUP_MODEL_SHA256, type CleanupSnapshot } from '../../../src/services/cleanup/types';
import { cleanTranscript } from '../../../src/services/dictation/cleanupStage';
import { signalFor } from '../../../src/services/dictation/signal';

const native = vi.hoisted(() => ({
  calls: [] as string[],
  cancel: 'ack' as 'ack' | 'hang' | 'reject-run',
  rejectRun: null as ((error: unknown) => void) | null,
}));
vi.mock('@tauri-apps/api/core', () => ({
  Channel: class { onmessage: unknown = null; },
  invoke: vi.fn((command: string) => {
    native.calls.push(command);
    if (command === 'cleanup_session_open') return Promise.resolve('session-1');
    if (command === 'cleanup_acquire' || command === 'cleanup_release') return Promise.resolve(undefined);
    if (command === 'cleanup_run') return new Promise((_resolve, reject) => { native.rejectRun = reject; });
    if (command === 'cleanup_cancel') {
      if (native.cancel === 'hang') return new Promise(() => {});
      if (native.cancel === 'reject-run') native.rejectRun?.({ code: 'cancelled', message: 'killed' });
      return Promise.resolve(undefined);
    }
    return Promise.resolve(null);
  }),
}));

const snapshot: CleanupSnapshot = { dictionary: [], enabled: true, modelId: CLEANUP_MODEL_ID, style: 'formal' };
const attempt = { modelDigest: CLEANUP_MODEL_SHA256, modelId: CLEANUP_MODEL_ID };

afterEach(() => {
  vi.useRealTimers();
  native.calls.length = 0;
  native.rejectRun = null;
});

describe('hung cleanup_run through the real adapter', () => {
  it.each(['reject-run', 'ack', 'hang'] as const)('native cancel %s: raw text at the deadline', async (mode) => {
    native.cancel = mode;
    vi.useFakeTimers();
    let settled: unknown = 'pending';
    void cleanTranscript({
      engine: createTauriCleanupEngine(), rawText: 'um send it', requestId: 'r1',
      signal: signalFor(new AbortController()), snapshot, timeoutMs: 1_000, userCancelled: () => false,
    }).then((outcome) => { settled = outcome; });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe('pending');
    await vi.advanceTimersByTimeAsync(CANCEL_GRACE_MS + 1);
    expect(settled).toMatchObject({ finalText: 'um send it', reason: 'timeout', status: 'fallback' });
    expect(native.calls).toContain('cleanup_cancel');
    await vi.advanceTimersByTimeAsync(10);
    expect(native.calls).toContain('cleanup_release');
  });
});

describe('a late result from a timed-out run is discarded', () => {
  it('neither its text nor its attempt evidence is used', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    let started!: (evidence: typeof attempt) => void;
    const engine = {
      cancel: vi.fn(() => new Promise<void>(() => {})),
      run: vi.fn((_request: unknown, onStarted?: (evidence: typeof attempt) => void) => {
        started = (evidence) => onStarted?.(evidence);
        return new Promise<{ attempt: typeof attempt; text: string }>((resolve) => {
          finish = () => resolve({ attempt, text: 'Send it.' });
        });
      }),
    };
    let settled: unknown = 'pending';
    void runCleanup({
      engine, rawText: 'um send it', requestId: 'r1',
      signal: signalFor(new AbortController()), snapshot, timeoutMs: 1_000,
    }).then((outcome) => { settled = outcome; });
    await vi.advanceTimersByTimeAsync(1_000 + CANCEL_GRACE_MS);
    expect(settled).toEqual({ finalText: 'um send it', reason: 'timeout', status: 'fallback' });
    started(attempt);
    finish();
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toEqual({ finalText: 'um send it', reason: 'timeout', status: 'fallback' });
  });

  it('a cancel that settles within the grace keeps its final attempt evidence', async () => {
    vi.useFakeTimers();
    let fail!: (error: unknown) => void;
    const { CleanupEngineError } = await import('../../../src/services/cleanup/types');
    const engine = {
      cancel: vi.fn(async () => { fail(new CleanupEngineError('cancelled', 'reaped', attempt)); }),
      run: vi.fn(() => new Promise<never>((_resolve, reject) => { fail = reject; })),
    };
    const pending = runCleanup({
      engine, rawText: 'um send it', requestId: 'r1',
      signal: signalFor(new AbortController()), snapshot, timeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ attempt, finalText: 'um send it', reason: 'timeout', status: 'fallback' });
  });
});

describe('dictation with a hung worker through the real adapter', () => {
  const stopped: CaptureState = { audio: { duration_ms: 1_500, id: 'pcm-1', sample_rate_hz: 16_000 }, kind: 'stopped' };
  const capture = (state: CaptureState): UseCaptureStateResult => ({
    cancelActiveCapture: vi.fn(), captureReady: true, captureState: state,
    deviceListError: null, devices: [], devicesLoading: false,
    permissionStatus: 'authorized', prepareDeviceChange: vi.fn().mockResolvedValue(true),
    refreshDevices: vi.fn().mockResolvedValue(undefined), requestMicPermission: vi.fn(),
    runMicTest: vi.fn(), startFullCaptureSession: vi.fn().mockResolvedValue('started'),
    stopFullCapture: vi.fn(), stopMicTest: vi.fn(),
    waitForCaptureRelease: vi.fn().mockResolvedValue(undefined),
  });

  it.each(['ack', 'hang'] as const)(
    'native cancel %s while cleanup_run never settles: raw delivery, a History row, out of cleaning',
    async (mode) => {
      native.cancel = mode;
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const store = createMockSttModelStore();
      await store.download('whisper-tiny.en');
      const clipboard = { copy: vi.fn().mockResolvedValue(undefined) };
      const onHistoryRecord = vi.fn();
      const engine = createTauriCleanupEngine();
      const hook = renderHook(() => useDogfoodCapture({
        captureApi: capture(stopped),
        cleanupActive: true,
        cleanupEngine: engine,
        cleanupModelId: CLEANUP_MODEL_ID,
        clipboard,
        createModelStore: () => store,
        deliveryPlatform: createStubDeliveryAdapter({ clipboard }),
        dogfood: (path) => dogfoodTranscribeAndCopy({
          ...path, createEngine: (modelId) => createMockSttEngine({ modelId, transcriptText: 'um send it' }),
        }),
        modelId: 'whisper-tiny.en',
        onHistoryRecord,
      }));
      await waitFor(() => expect(hook.result.current.phase).toBe('cleaning'));
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000 + CANCEL_GRACE_MS + 100); });
      expect(hook.result.current.phase).toBe('success');
      expect(clipboard.copy).toHaveBeenCalledExactlyOnceWith('um send it');
      // Provenance digests are async (SubtleCrypto), so the row lands just after.
      await waitFor(() => expect(onHistoryRecord).toHaveBeenCalledOnce());
      expect(onHistoryRecord.mock.calls[0][0]).toMatchObject({
        cleanup: { reason: 'timeout', status: 'fallback' }, text: 'um send it',
      });
      hook.unmount();
    },
  );
});
