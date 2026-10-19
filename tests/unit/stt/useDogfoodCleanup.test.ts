/** @vitest-environment jsdom */
// BUS-16 PR 2c: the dogfood hook runs optional cleanup only when it is
// enabled AND explicitly opted in, and never loses a dictation.
import { readFileSync } from 'node:fs';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isCleanupActive } from '../../../src/domain/cleanup';
import type { CleanupEngine } from '../../../src/services/cleanup/contracts';
import {
  CLEANUP_MODEL_ID,
  CLEANUP_MODEL_SHA256,
  CleanupEngineError,
} from '../../../src/services/cleanup/types';
import type { CaptureState } from '../../../src/services/capture/types';
import type { UseCaptureStateResult } from '../../../src/services/capture/useCaptureState';
import { createStubDeliveryAdapter } from '../../../src/services/delivery';
import { parseSettingsJson } from '../../../src/services/settings';
import { dogfoodTranscribeAndCopy } from '../../../src/services/stt/dogfoodPath';
import { createMockSttEngine, createMockSttModelStore } from '../../../src/services/stt/mockStt';
import {
  useDogfoodCapture,
  type UseDogfoodCaptureOptions,
} from '../../../src/services/stt/useDogfoodCapture';

const nativeEngine = vi.hoisted(() => ({
  created: 0,
  dispose: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/services/cleanup/tauriAdapter', () => ({
  createTauriCleanupEngine: () => {
    nativeEngine.created++;
    return {
      cancel: vi.fn().mockResolvedValue(undefined),
      dispose: nativeEngine.dispose,
      run: vi.fn().mockRejectedValue(new CleanupEngineError('runtime-error', 'no worker')),
    } satisfies CleanupEngine;
  },
}));

const attempt = { modelDigest: CLEANUP_MODEL_SHA256, modelId: CLEANUP_MODEL_ID };
const RAW = 'um send to voxlom';

function stubCapture(state: CaptureState): UseCaptureStateResult {
  return {
    cancelActiveCapture: vi.fn(), captureReady: true, captureState: state,
    deviceListError: null, devices: [], devicesLoading: false,
    permissionStatus: 'authorized', prepareDeviceChange: vi.fn().mockResolvedValue(true),
    refreshDevices: vi.fn().mockResolvedValue(undefined), requestMicPermission: vi.fn(),
    runMicTest: vi.fn(), startFullCaptureSession: vi.fn().mockResolvedValue('started'),
    stopFullCapture: vi.fn(), stopMicTest: vi.fn(),
  };
}

function fakeEngine(run: CleanupEngine['run']) {
  return {
    acquire: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    run: vi.fn(run),
  } satisfies CleanupEngine;
}

const stopped = (id: string): CaptureState => ({
  audio: { duration_ms: 1_500, id, sample_rate_hz: 16_000 }, kind: 'stopped',
});

async function setup(options: Partial<UseDogfoodCaptureOptions>, state = stopped('pcm-1')) {
  const store = createMockSttModelStore();
  await store.download('whisper-tiny.en');
  const copy = vi.fn().mockResolvedValue(undefined);
  const clipboard = { copy };
  const onHistoryRecord = vi.fn();
  const dogfood: typeof dogfoodTranscribeAndCopy = (path) => dogfoodTranscribeAndCopy({
    ...path,
    createEngine: (modelId) => createMockSttEngine({ modelId, transcriptText: RAW }),
  });
  const hook = renderHook(({ capture }: { capture: CaptureState }) => useDogfoodCapture({
    captureApi: stubCapture(capture),
    clipboard,
    cleanupModelId: CLEANUP_MODEL_ID,
    createModelStore: () => store,
    deliveryPlatform: createStubDeliveryAdapter({ clipboard }),
    dictionary: ['Voxloom'],
    dogfood,
    modelId: 'whisper-tiny.en',
    onHistoryRecord,
    ...options,
  }), { initialProps: { capture: state } });
  return { copy, hook, onHistoryRecord };
}

beforeEach(() => {
  nativeEngine.created = 0;
  nativeEngine.dispose.mockClear();
});

describe('useDogfoodCapture cleanup', () => {
  it('a #24-era settings file (cleanupEnabled, no opt-in) never runs cleanup', async () => {
    const parsed = parseSettingsJson(readFileSync('tests/fixtures/settings-v2-pr24.json', 'utf8'));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.file.settings.cleanupEnabled).toBe(true);
    const engine = fakeEngine(async () => ({ attempt, text: 'Send to Voxloom.' }));
    const { copy, hook, onHistoryRecord } = await setup({
      cleanupActive: isCleanupActive(parsed.file.settings),
      cleanupEngine: engine,
      cleanupModelId: parsed.file.settings.cleanupModelId,
    });
    await waitFor(() => expect(hook.result.current.phase).toBe('success'));
    expect(engine.acquire).not.toHaveBeenCalled();
    expect(engine.run).not.toHaveBeenCalled();
    expect(copy).toHaveBeenCalledWith(RAW);
    expect(onHistoryRecord.mock.calls[0][0]).toMatchObject({
      cleanup: { status: 'skipped' }, text: RAW,
    });
    hook.unmount();
    expect(nativeEngine.created).toBe(0);
  });

  it('cleans, delivers the cleaned text and records provenance', async () => {
    const engine = fakeEngine(async () => ({ attempt, text: 'Send to Voxloom.' }));
    const { copy, hook, onHistoryRecord } = await setup({ cleanupActive: true, cleanupEngine: engine, style: 'casual' });
    await waitFor(() => expect(hook.result.current.phase).toBe('success'));
    expect(engine.acquire).toHaveBeenCalledWith('cleanup-pcm-1', CLEANUP_MODEL_ID);
    expect(engine.run.mock.calls[0][0]).toMatchObject({
      dictionary: ['Voxloom'], rawText: RAW, requestId: 'cleanup-pcm-1', style: 'casual',
    });
    expect(copy).toHaveBeenCalledWith('Send to Voxloom.');
    expect(onHistoryRecord.mock.calls[0][0]).toMatchObject({
      cleanup: {
        modelDigest: CLEANUP_MODEL_SHA256, modelId: CLEANUP_MODEL_ID,
        reason: null, status: 'cleaned',
      },
      rawText: RAW,
      text: 'Send to Voxloom.',
    });
    expect(engine.release).toHaveBeenCalledWith('cleanup-pcm-1');
  });

  it('shows the cleaning phase while the worker runs', async () => {
    let finish!: (text: string) => void;
    const engine = fakeEngine(() => new Promise((resolve) => {
      finish = (text) => resolve({ attempt, text });
    }));
    const { hook } = await setup({ cleanupActive: true, cleanupEngine: engine });
    await waitFor(() => expect(hook.result.current.phase).toBe('cleaning'));
    expect(hook.result.current.message).toBe('Cleaning up…');
    await act(async () => { finish('Send to Voxloom.'); });
    await waitFor(() => expect(hook.result.current.phase).toBe('success'));
  });

  it.each([
    ['a worker error', async () => { throw new CleanupEngineError('runtime-error', 'boom'); }, 'runtime-error'],
    ['a validator reject', async () => ({ attempt, text: 'Send the password.' }), 'invalid-output'],
  ] as const)('delivers the raw text on %s', async (_label, run, reason) => {
    const engine = fakeEngine(run as CleanupEngine['run']);
    const { copy, hook, onHistoryRecord } = await setup({ cleanupActive: true, cleanupEngine: engine });
    await waitFor(() => expect(hook.result.current.phase).toBe('success'));
    expect(copy).toHaveBeenCalledWith(RAW);
    expect(onHistoryRecord.mock.calls[0][0]).toMatchObject({
      cleanup: { reason, status: 'fallback' }, rawText: RAW, text: RAW,
    });
  });

  it('cancel during cleanup delivers nothing and records nothing', async () => {
    const engine = fakeEngine(() => new Promise(() => {}));
    const { copy, hook, onHistoryRecord } = await setup({ cleanupActive: true, cleanupEngine: engine });
    await waitFor(() => expect(hook.result.current.phase).toBe('cleaning'));
    act(() => { hook.result.current.cancel(); });
    await waitFor(() => expect(engine.cancel).toHaveBeenCalledWith('cleanup-pcm-1'));
    await act(async () => { await Promise.resolve(); });
    expect(hook.result.current.phase).toBe('cancelled');
    expect(copy).not.toHaveBeenCalled();
    expect(onHistoryRecord).not.toHaveBeenCalled();
  });

  it('a new start supersedes cleanup: the old run keeps its raw text in History', async () => {
    const engine = fakeEngine(() => new Promise(() => {}));
    const { copy, hook, onHistoryRecord } = await setup({ cleanupActive: true, cleanupEngine: engine });
    await waitFor(() => expect(hook.result.current.phase).toBe('cleaning'));
    hook.rerender({ capture: { kind: 'idle' } });
    await act(async () => { await hook.result.current.start(); });
    await waitFor(() => expect(onHistoryRecord).toHaveBeenCalledOnce());
    expect(engine.cancel).toHaveBeenCalledWith('cleanup-pcm-1');
    expect(onHistoryRecord.mock.calls[0][0]).toMatchObject({
      cleanup: { reason: 'cancelled', status: 'fallback' }, text: RAW,
    });
    // Superseded sessions are never delivered (unchanged from main).
    expect(copy).not.toHaveBeenCalled();
  });

  it('creates the native engine only when cleanup runs, and disposes it on unmount', async () => {
    const { copy, hook } = await setup({ cleanupActive: true });
    await waitFor(() => expect(hook.result.current.phase).toBe('success'));
    expect(nativeEngine.created).toBe(1);
    expect(copy).toHaveBeenCalledWith(RAW);
    hook.unmount();
    expect(nativeEngine.dispose).toHaveBeenCalledOnce();
  });

  it('the opt-in alone runs cleanup; the legacy cleanupEnabled is ignored', async () => {
    const parsed = parseSettingsJson(JSON.stringify({
      onboardingComplete: true,
      settings: { cleanupEnabled: false, cleanupModelId: CLEANUP_MODEL_ID, cleanupOptIn: true },
      version: 2,
    }));
    if (!parsed.ok) throw new Error(parsed.error);
    const engine = fakeEngine(async () => ({ attempt, text: 'Send to Voxloom.' }));
    const { copy, hook } = await setup({
      cleanupActive: isCleanupActive(parsed.file.settings), cleanupEngine: engine,
    });
    await waitFor(() => expect(hook.result.current.phase).toBe('success'));
    expect(engine.run).toHaveBeenCalledOnce();
    expect(copy).toHaveBeenCalledWith('Send to Voxloom.');
  });

  it('keeps the HUD up and Escape-cancellable while cleaning', async () => {
    const engine = fakeEngine(() => new Promise(() => {}));
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const clipboard = { copy: vi.fn().mockResolvedValue(undefined) };
    let captureState: CaptureState = { kind: 'idle' };
    const { result, rerender } = renderHook(({ state }: { state: CaptureState }) => useDogfoodCapture({
      captureApi: {
        ...stubCapture(state),
        startFullCaptureSession: async () => {
          captureState = { device: 'Mic', generation: 1, kind: 'active', request_id: 'full-1' };
          return 'started';
        },
        stopFullCapture: async () => { captureState = stopped('pcm-hud'); },
      },
      cleanupActive: true,
      cleanupEngine: engine,
      cleanupModelId: CLEANUP_MODEL_ID,
      clipboard,
      createModelStore: () => store,
      deliveryPlatform: createStubDeliveryAdapter({ clipboard }),
      dogfood: (path) => dogfoodTranscribeAndCopy({
        ...path, createEngine: (modelId) => createMockSttEngine({ modelId, transcriptText: RAW }),
      }),
      modelId: 'whisper-tiny.en',
    }), { initialProps: { state: captureState } });
    await act(async () => { await result.current.start(); });
    rerender({ state: captureState });
    await waitFor(() => expect(result.current.scopeReady).toBe(true));
    await act(async () => { await result.current.stop(); });
    rerender({ state: captureState });
    await waitFor(() => expect(result.current.phase).toBe('cleaning'));
    expect(result.current.hudReady).toBe(true);
    expect(result.current.scopeReady).toBe(true);
    act(() => { result.current.cancel(); });
    await waitFor(() => expect(engine.cancel).toHaveBeenCalledWith('cleanup-pcm-hud'));
    expect(clipboard.copy).not.toHaveBeenCalled();
  });

  it('cleanup and the History row use the style captured at stop', async () => {
    let finish!: (text: string) => void;
    const engine = fakeEngine(() => new Promise((resolve) => {
      finish = (text) => resolve({ attempt, text });
    }));
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const clipboard = { copy: vi.fn().mockResolvedValue(undefined) };
    const onHistoryRecord = vi.fn();
    const hook = renderHook(({ style }: { style: 'casual' | 'formal' }) => useDogfoodCapture({
      captureApi: stubCapture(stopped('pcm-1')),
      cleanupActive: true,
      cleanupEngine: engine,
      cleanupModelId: CLEANUP_MODEL_ID,
      clipboard,
      createModelStore: () => store,
      deliveryPlatform: createStubDeliveryAdapter({ clipboard }),
      dogfood: (path) => dogfoodTranscribeAndCopy({
        ...path, createEngine: (modelId) => createMockSttEngine({ modelId, transcriptText: RAW }),
      }),
      modelId: 'whisper-tiny.en',
      onHistoryRecord,
      style,
    }), { initialProps: { style: 'casual' as 'casual' | 'formal' } });
    await waitFor(() => expect(hook.result.current.phase).toBe('cleaning'));
    hook.rerender({ style: 'formal' });
    await act(async () => { finish('Send to Voxloom.'); });
    await waitFor(() => expect(onHistoryRecord).toHaveBeenCalledOnce());
    expect(engine.run.mock.calls[0][0]).toMatchObject({ style: 'casual' });
    expect(onHistoryRecord.mock.calls[0][0]).toMatchObject({ style: 'casual' });
  });
});

describe('useDogfoodCapture with a hung cleanup worker', () => {
  afterEach(() => { vi.useRealTimers(); });

  it.each([
    ['run AND cancel never settle', () => new Promise<void>(() => {})],
    ['cancel replies but run never finishes', () => Promise.resolve()],
  ])('%s: raw text and a History row at the deadline, then a new dictation works', async (_label, cancel) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    const engine = {
      ...fakeEngine(async () => {
        // The first run hangs forever; a later dictation cleans normally.
        if (++calls === 1) return new Promise<never>(() => {});
        return { attempt, text: 'Send to Voxloom.' };
      }),
      cancel: vi.fn(cancel),
    };
    const { copy, hook, onHistoryRecord } = await setup({ cleanupActive: true, cleanupEngine: engine });
    await waitFor(() => expect(hook.result.current.phase).toBe('cleaning'));
    await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
    expect(hook.result.current.phase).toBe('cleaning');
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(hook.result.current.phase).toBe('success');
    expect(engine.cancel).toHaveBeenCalledWith('cleanup-pcm-1');
    expect(copy).toHaveBeenCalledExactlyOnceWith(RAW);
    await waitFor(() => expect(onHistoryRecord).toHaveBeenCalledOnce());
    expect(onHistoryRecord.mock.calls[0][0]).toMatchObject({
      cleanup: { reason: 'timeout', status: 'fallback' }, rawText: RAW, text: RAW,
    });
    expect(engine.release).toHaveBeenCalledWith('cleanup-pcm-1');

    // A later dictation still works while the old cancel may be pending.
    hook.rerender({ capture: { kind: 'idle' } });
    await act(async () => { await hook.result.current.start(); });
    hook.rerender({ capture: stopped('pcm-2') });
    await waitFor(() => expect(onHistoryRecord).toHaveBeenCalledTimes(2));
    expect(onHistoryRecord.mock.calls[1][0]).toMatchObject({ cleanup: { status: 'cleaned' }, text: 'Send to Voxloom.' });
    expect(copy).toHaveBeenLastCalledWith('Send to Voxloom.');
    // Nothing from the hung run lands later.
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(onHistoryRecord).toHaveBeenCalledTimes(2);
    expect(copy).toHaveBeenCalledTimes(2);
  });
});
