import { act, renderHook, waitFor } from '@testing-library/react';
import { createInitialState } from '../../src/app/initialState';
import { toGestureDogfoodBridge, useShortcutGestures } from '../../src/app/useShortcutGestures';
import { createOverlayBridge } from '../../src/services/shortcut/overlayBridge';
import type { DictationLifecycle, SetupLifecycle } from '../../src/services/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDogfoodCapture } from '../../src/services/stt/useDogfoodCapture';
import { createMockSttEngine, createMockSttModelStore } from '../../src/services/stt/mockStt';
import { dogfoodTranscribeAndCopy } from '../../src/services/stt/dogfoodPath';
import { createStubDeliveryAdapter } from '../../src/services/delivery';
import type { CaptureState } from '../../src/services/capture/types';
import type { UseCaptureStateResult } from '../../src/services/capture/useCaptureState';

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), overlay: vi.fn() }));
vi.mock('../../src/services/shortcut', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/shortcut')>(),
  createOverlayBridge: ipc.overlay,
  createNativeShortcutController: () => ({
    dispose: vi.fn(), setContext: vi.fn(), resetPartial: vi.fn(),
    setShortcut: vi.fn().mockResolvedValue({ ok: true }),
  }),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: ipc.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: ipc.listen, emit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/services/capture/useCaptureState', () => ({ useCaptureState: () => ({}) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => { vi.resetAllMocks(); });

describe('BUS-43 pending acquisition ownership', () => {
  it.each(['cancel-ax-untrusted', 'cancel-tap-create-failed'])(
    'keeps capture closed and preserves the full %s diagnostic from IPC', async (code) => {
      const message = `Escape cancellation unavailable [${code}]. ax=true listen=false post=true`;
      const unlisten = vi.fn();
      ipc.listen.mockResolvedValue(unlisten);
      ipc.invoke.mockRejectedValue(message);
      const startCapture = vi.fn();
      const dogfood = vi.fn();
      const copy = vi.fn();
      const history = vi.fn();
      const toast = vi.fn();
      const { result } = renderHook(() => useDogfoodCapture({
        captureApi: { captureState: { kind: 'idle' }, startFullCaptureSession: startCapture,
          cancelActiveCapture: vi.fn() } as unknown as UseCaptureStateResult,
        clipboard: { copy }, createModelStore: createMockSttModelStore, modelId: 'whisper-tiny.en',
        dogfood, onHistoryRecord: history, onToast: toast,
      }));
      await act(async () => { await result.current.start('gesture'); });
      expect(result.current.phase).toBe('error');
      expect(result.current.scopeReady).toBe(false);
      expect(result.current.message).toBe(message);
      expect(toast).toHaveBeenCalledWith(message);
      expect(startCapture).not.toHaveBeenCalled();
      expect(dogfood).not.toHaveBeenCalled();
      expect(history).not.toHaveBeenCalled();
      expect(copy).not.toHaveBeenCalled();
      expect(unlisten).toHaveBeenCalledOnce();
    },
  );
  it.each([
    ['cancelled', 'success', false], ['cancelled', 'failure', false],
    ['ordinary', 'success', false], ['ordinary', 'failure', false],
    ['cancelled', 'success', true], ['cancelled', 'failure', true],
    ['ordinary', 'success', true], ['ordinary', 'failure', true],
  ] as const)('%s A survives restart with the correct late %s policy (pending retirement: %s)', async (mode, outcome, delayed) => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const pending = deferred<void>();
    const finishReply = deferred<void>();
    if (!delayed) finishReply.resolve();
    let owner: { session: string; cancelled: boolean } | null = null;
    const listeners = new Set<(event: { payload: string }) => void>();
    ipc.listen.mockImplementation(async (_event, handler) => {
      listeners.add(handler);
      return () => { listeners.delete(handler); };
    });
    // Model the real native single ACTIVE slot: arm replaces it; finish reads
    // its latch and removes only that exact session. End discards the latch.
    ipc.invoke.mockImplementation(async (command, { session }) => {
      if (command === 'dictation_cancel_arm') owner = { session, cancelled: false };
      if (command === 'dictation_cancel_finish') {
        const accepted = owner !== null && owner.session === session && !owner.cancelled;
        if (owner?.session === session) owner = null;
        await finishReply.promise;
        return accepted;
      }
      if (command === 'dictation_cancel_end' && owner?.session === session) owner = null;
      return undefined;
    });
    const transcribe = vi.fn(async () => {
      await pending.promise;
      if (outcome === 'failure') throw new Error('A late failure');
      return { text: 'A transcript', language: 'en' };
    });
    const clip = { copy: vi.fn().mockResolvedValue(undefined) };
    const snapshot = vi.fn().mockResolvedValue(null);
    const insert = vi.fn();
    const history = vi.fn();
    const toast = vi.fn();
    const dogfood: typeof dogfoodTranscribeAndCopy = (options) => dogfoodTranscribeAndCopy({
      ...options, createEngine: () => ({ ...createMockSttEngine(), transcribe }),
    });
    const { result, rerender } = renderHook(({ state }: { state: CaptureState }) => useDogfoodCapture({
      captureApi: { captureState: state, startFullCaptureSession: vi.fn().mockResolvedValue('started'),
        cancelActiveCapture: vi.fn() } as unknown as UseCaptureStateResult,
      clipboard: clip, createModelStore: () => store, modelId: 'whisper-tiny.en',
      deliveryPlatform: createStubDeliveryAdapter({ clipboard: clip, snapshot, insert }),
      onHistoryRecord: history, onToast: toast, dogfood,
    }), { initialProps: { state: { kind: 'idle' } as CaptureState } });
    await act(async () => { await result.current.start(); });
    rerender({ state: { kind: 'stopped', audio: { id: 'A', duration_ms: 1000, sample_rate_hz: 16000 } } });
    await waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
    const oldOwner = owner!;
    if (mode === 'cancelled') oldOwner.cancelled = true;
    toast.mockClear();
    // Withhold the renderer notification until after B replaces A.
    rerender({ state: { kind: 'idle' } });
    let restart!: Promise<void>;
    act(() => { restart = result.current.start(); });
    if (delayed) {
      // C must inherit A's retirement while B is still awaiting the IPC reply.
      let newest!: Promise<void>;
      act(() => { newest = result.current.start(); });
      await act(async () => { pending.resolve(); });
      expect(ipc.invoke.mock.calls.filter(([command]) => command === 'dictation_cancel_arm')).toHaveLength(1);
      expect(history).not.toHaveBeenCalled();
      await act(async () => { finishReply.resolve(); await newest; await restart; });
    } else {
      await act(async () => { await restart; });
    }
    const newerOwner = owner;
    expect(newerOwner).not.toBeNull();
    expect(newerOwner).not.toBe(oldOwner);
    // In the delayed case A can publish ordinary evidence as retirement ends.
    if (!delayed) toast.mockClear();
    await act(async () => { pending.resolve(); });
    expect(result.current.phase).toBe('recording');
    expect(owner).toBe(newerOwner);
    expect(snapshot).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(clip.copy).not.toHaveBeenCalled();
    if (mode === 'cancelled') {
      expect.soft(history).not.toHaveBeenCalled();
      expect.soft(toast.mock.calls.filter(([text]) => text !== 'Listening…')).toHaveLength(0);
    } else {
      expect(toast.mock.calls.filter(([text]) => text !== 'Listening…')).toHaveLength(1);
      expect(history).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
    }
    act(() => { for (const handler of listeners) handler({ payload: oldOwner.session }); });
    expect(result.current.phase).toBe('recording');
    // B remains usable, not merely alive: it can complete and copy normally.
    transcribe.mockResolvedValue({ text: 'B transcript', language: 'en' });
    rerender({ state: { kind: 'stopped', audio: { id: 'B', duration_ms: 1000, sample_rate_hz: 16000 } } });
    await waitFor(() => expect(result.current.phase).toBe('success'));
    expect(clip.copy).toHaveBeenCalledWith('B transcript');
    expect(history.mock.calls.at(-1)?.[0].text).toBe('B transcript');
    expect(owner).toBeNull();
  });

  it.each(['model', 'microphone'] as const)(
    'shows a cancellable popup after delayed arm while %s startup is pending', async (stage) => {
      const store = createMockSttModelStore();
      await store.download('whisper-tiny.en');
      const arm = deferred<void>();
      const startup = deferred<void>();
      let owner: string | null = null;
      let visible = false;
      let cancelEvent!: (event: { payload: string }) => void;
      ipc.listen.mockImplementation(async (event, handler) => {
        // Shortcut-query listeners share this API but must not replace Escape.
        if (event === 'dictation:cancel') cancelEvent = handler;
        return vi.fn();
      });
      ipc.invoke.mockImplementation(async (command, { session }) => {
        if (command === 'dictation_cancel_arm') { await arm.promise; owner = session; }
        if (command === 'dictation_cancel_end' && owner === session) { owner = null; visible = false; }
        return true;
      });
      const show = vi.fn(async () => {
        if (!owner) throw new Error('no cancellable scope');
        visible = true;
      });
      ipc.overlay.mockImplementation(() => createOverlayBridge({
        isAvailable: () => true, ensureCreated: async () => {}, setWaveform: async () => {},
        hide: async () => { visible = false; }, showBottomCenter: show,
      }));
      const status = store.status.bind(store);
      store.status = vi.fn(async (id) => { if (stage === 'model') await startup.promise; return status(id); });
      const startCapture = vi.fn(async () => { if (stage === 'microphone') await startup.promise; return 'started'; });
      const api = { captureState: { kind: 'idle' }, startFullCaptureSession: startCapture,
        cancelActiveCapture: vi.fn() } as unknown as UseCaptureStateResult;
      const state = createInitialState(0);
      const { result } = renderHook(() => {
        const dogfood = useDogfoodCapture({ captureApi: api, clipboard: { copy: vi.fn() },
          createModelStore: () => store, modelId: 'whisper-tiny.en' });
        useShortcutGestures({ dogfood: toGestureDogfoodBridge(dogfood), state, now: () => 0,
          onboardingOpen: false, shortcutOpen: false,
          dictation: { cancel: vi.fn() } as unknown as DictationLifecycle,
          setup: {} as SetupLifecycle });
        return dogfood;
      });
      let start!: Promise<void>;
      act(() => { start = result.current.start(); });
      await act(async () => { await Promise.resolve(); });
      expect(visible).toBe(false);
      await act(async () => { arm.resolve(); });
      await waitFor(() => expect(visible).toBe(true));
      expect(result.current.phase).toBe('starting');
      // Emulate the OS latch + delayed notification while startup is blocked.
      const session = owner!;
      visible = false;
      act(() => cancelEvent({ payload: session }));
      expect(result.current.phase).toBe('cancelled');
      expect(result.current.scopeReady).toBe(false);
      await act(async () => { startup.resolve(); await start; });
      expect(result.current.phase).toBe('cancelled');
      expect(visible).toBe(false);
      expect(owner).toBeNull();
    });

  it('cancel and immediate restart cannot let an old listener replace the newer native scope', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const first = deferred<() => void>();
    const unlistenOld = vi.fn();
    ipc.listen.mockReturnValueOnce(first.promise).mockResolvedValue(vi.fn());
    let owner: string | null = null;
    ipc.invoke.mockImplementation(async (command, { session }) => {
      if (command === 'dictation_cancel_arm') owner = session;
      if (command === 'dictation_cancel_end' && owner === session) owner = null;
      return true;
    });
    const startCapture = vi.fn().mockResolvedValue('started');
    const { result } = renderHook(() => useDogfoodCapture({
      captureApi: { captureState: { kind: 'idle' }, startFullCaptureSession: startCapture,
        cancelActiveCapture: vi.fn() } as unknown as UseCaptureStateResult,
      clipboard: { copy: vi.fn() }, createModelStore: () => store, modelId: 'whisper-tiny.en',
    }));
    let oldStart!: Promise<void>;
    act(() => { oldStart = result.current.start(); });
    act(() => result.current.cancel());
    await act(async () => { await result.current.start(); });
    const newerOwner = owner;
    expect(newerOwner).not.toBeNull();
    await act(async () => { first.resolve(unlistenOld); await oldStart; });
    expect(owner).toBe(newerOwner);
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'dictation_cancel_arm')).toHaveLength(1);
    expect(unlistenOld).toHaveBeenCalledOnce();
    expect(startCapture).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe('recording');
  });
});
