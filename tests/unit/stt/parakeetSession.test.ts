import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureState } from '../../../src/services/capture/types';
import type { UseCaptureStateResult } from '../../../src/services/capture/useCaptureState';
import { useDogfoodCapture } from '../../../src/services/stt/useDogfoodCapture';
import { createMockSttModelStore } from '../../../src/services/stt/mockStt';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => true }));
vi.mock('../../../src/services/capture/useCaptureState', () => ({ useCaptureState: () => null }));
vi.mock('../../../src/services/shortcut/cancelScope', () => ({ beginCancelScope: async () => ({ dispose: async () => {}, finish: async () => true }) }));

function capture(state: CaptureState): UseCaptureStateResult {
  return {
    captureState: state, cancelActiveCapture: vi.fn(), captureReady: true,
    startFullCaptureSession: vi.fn().mockResolvedValue('started'), stopFullCapture: vi.fn().mockResolvedValue(undefined),
    devices: [], devicesLoading: false, deviceListError: null, permissionStatus: 'authorized',
    prepareDeviceChange: vi.fn(), refreshDevices: vi.fn(), requestMicPermission: vi.fn(), runMicTest: vi.fn(), stopMicTest: vi.fn(),
  };
}
const audio = { id: 'pcm-parakeet', duration_ms: 500, sample_rate_hz: 16000 };

describe('Parakeet recording sessions', () => {
  it('disposes stopped PCM when processing fails before native transcription', async () => {
    const store = createMockSttModelStore();
    await store.download('parakeet-tdt-0.6b-v3');
    const mic = capture({ kind: 'idle' });
    const history = vi.fn();
    const copy = vi.fn();
    // Exercise the real start → preparation → stopped-processing hook chain,
    // with a renderer-side failure before the native PCM consumer is called.
    const dogfood = vi.fn().mockRejectedValue(new Error('Renderer processing failed'));
    const { result, rerender } = renderHook(({ state }: { state: CaptureState }) => useDogfoodCapture({ captureApi: { ...mic, captureState: state }, clipboard: { copy }, dogfood, modelId: 'parakeet-tdt-0.6b-v3', createModelStore: () => store, onHistoryRecord: history }), { initialProps: { state: { kind: 'idle' } as CaptureState } });
    await act(async () => { await result.current.start(); });
    const requestId = invoke.mock.calls.find(([c]) => c === 'stt_prepare')![1].requestId;
    rerender({ state: { kind: 'stopped', audio } });
    await waitFor(() => expect(result.current.phase).toBe('error'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('stt_release', { requestId, bufferId: audio.id }));
    expect(dogfood).toHaveBeenCalledOnce();
    expect(invoke.mock.calls.filter(([c]) => c === 'stt_transcribe')).toHaveLength(0);
    expect(history).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });
  it.each(['accepted', 'rejected'] as const)('disposes a late stopped buffer after cancellation with %s admission', async (admission) => {
    const store = createMockSttModelStore();
    await store.download('parakeet-tdt-0.6b-v3');
    let admit!: () => void;
    let reject!: (error: unknown) => void;
    invoke.mockImplementation((command: string) => command === 'stt_prepare'
      ? new Promise<void>((resolve, fail) => { admit = resolve; reject = fail; })
      : Promise.resolve());
    const mic = capture({ kind: 'idle' });
    const history = vi.fn();
    const copy = vi.fn();
    const { result, rerender } = renderHook(({ state }: { state: CaptureState }) => useDogfoodCapture({ captureApi: { ...mic, captureState: state }, clipboard: { copy }, modelId: 'parakeet-tdt-0.6b-v3', createModelStore: () => store, onHistoryRecord: history }), { initialProps: { state: { kind: 'idle' } as CaptureState } });
    let starting!: Promise<void>;
    act(() => { starting = result.current.start(); });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('stt_prepare', expect.anything()));
    const requestId = invoke.mock.calls.find(([c]) => c === 'stt_prepare')![1].requestId;
    act(() => result.current.cancel());
    await act(async () => {
      if (admission === 'accepted') admit();
      else reject({ code: 'busy', message: 'Admission refused' });
      await starting;
    });
    rerender({ state: { kind: 'stopped', audio } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('stt_release', { requestId, bufferId: audio.id }));
    rerender({ state: { kind: 'stopped', audio } });
    expect(invoke.mock.calls.filter(([c, payload]) => c === 'stt_release' && payload.bufferId === audio.id)).toHaveLength(1);
    expect(invoke.mock.calls.filter(([c]) => c === 'stt_cancel')).toHaveLength(admission === 'accepted' ? 1 : 0);
    expect(invoke.mock.calls.filter(([c]) => c === 'stt_transcribe')).toHaveLength(0);
    expect(mic.startFullCaptureSession).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('cancelled');
  });
  it('releases stopped PCM for the cancelled request even when the start binding lookup is still pending', async () => {
    const store = createMockSttModelStore();
    await store.download('parakeet-tdt-0.6b-v3');
    invoke.mockImplementation((command: string) => command === 'delivery_paste_binding'
      ? new Promise(() => {}) : Promise.resolve());
    const mic = capture({ kind: 'idle' });
    const history = vi.fn();
    const copy = vi.fn();
    const { result, rerender } = renderHook(({ state }: { state: CaptureState }) => useDogfoodCapture({ captureApi: { ...mic, captureState: state }, clipboard: { copy }, modelId: 'parakeet-tdt-0.6b-v3', createModelStore: () => store, onHistoryRecord: history }), { initialProps: { state: { kind: 'idle' } as CaptureState } });
    await act(async () => { await result.current.start(); });
    const requestId = invoke.mock.calls.find(([c]) => c === 'stt_prepare')![1].requestId;
    rerender({ state: { kind: 'stopped', audio } });
    await waitFor(() => expect(result.current.phase).toBe('transcribing'));
    act(() => result.current.cancel());
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('stt_release', { requestId, bufferId: audio.id }));
    expect(invoke.mock.calls.filter(([c]) => c === 'stt_transcribe')).toHaveLength(0);
    expect(history).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('cancelled');
  });
  it.each(['supersede', 'cancel', 'failure'] as const)('settles a stopped request after %s without losing History or cancelling its successor', async (ending) => {
    const store = createMockSttModelStore();
    await store.download('parakeet-tdt-0.6b-v2');
    let finish!: (value: unknown) => void;
    let fail!: (reason: unknown) => void;
    invoke.mockImplementation((command: string) => command === 'stt_transcribe'
      ? new Promise((resolve, reject) => { finish = resolve; fail = reject; }) : Promise.resolve());
    const mic = capture({ kind: 'idle' });
    const history = vi.fn();
    const copy = vi.fn();
    const { result, rerender } = renderHook(({ state }: { state: CaptureState }) => useDogfoodCapture({ captureApi: { ...mic, captureState: state }, clipboard: { copy }, modelId: 'parakeet-tdt-0.6b-v2', createModelStore: () => store, onHistoryRecord: history }), { initialProps: { state: { kind: 'idle' } as CaptureState } });
    await act(async () => { await result.current.start(); });
    const requestId = invoke.mock.calls.find(([c]) => c === 'stt_prepare')![1].requestId;
    rerender({ state: { kind: 'stopped', audio } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('stt_transcribe', expect.objectContaining({ requestId })));
    rerender({ state: { kind: 'idle' } });
    if (ending === 'supersede') {
      await act(async () => { await result.current.start(); });
      expect(invoke).not.toHaveBeenCalledWith('stt_release', { requestId });
      expect(invoke).not.toHaveBeenCalledWith('stt_cancel', { requestId });
    } else if (ending === 'cancel') act(() => result.current.cancel());
    await act(async () => {
      if (ending === 'failure') fail({ code: 'transcribe-failed', message: 'load failed' });
      else finish({ text: 'earlier transcript' });
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('stt_release', { requestId, bufferId: audio.id }));
    expect(invoke.mock.calls.filter(([c]) => c === 'stt_transcribe')).toHaveLength(1);
    expect(invoke.mock.calls.filter(([c]) => c === 'stt_cancel' || c === 'stt_release')).toEqual(ending === 'cancel'
      ? [['stt_cancel', { requestId }], ['stt_release', { requestId, bufferId: audio.id }]]
      : [['stt_release', { requestId, bufferId: audio.id }]]);
    if (ending === 'supersede') {
      await waitFor(() => expect(history).toHaveBeenCalledWith(expect.objectContaining({ text: 'earlier transcript', model: 'parakeet-tdt-0.6b-v2' })));
      expect(result.current.phase).toBe('recording');
    } else {
      expect(history).not.toHaveBeenCalled();
      expect(result.current.phase).toBe(ending === 'cancel' ? 'cancelled' : 'error');
    }
    expect(copy).not.toHaveBeenCalled();
  });
  it.each(['permission', 'busy', 'throw', 'no-audio', 'capture-error', 'capture-cancelled', 'supersede', 'unmount'] as const)('retires abandoned preparation after %s', async (ending) => {
    const store = createMockSttModelStore();
    await store.download('parakeet-tdt-0.6b-v3');
    const mic = capture({ kind: 'idle' });
    if (ending === 'permission') vi.mocked(mic.startFullCaptureSession).mockResolvedValue('error');
    if (ending === 'busy') vi.mocked(mic.startFullCaptureSession).mockResolvedValue('busy');
    if (ending === 'throw') vi.mocked(mic.startFullCaptureSession).mockRejectedValue(new Error('mic unavailable'));
    const { result, rerender, unmount } = renderHook(({ state }: { state: CaptureState }) => useDogfoodCapture({ captureApi: { ...mic, captureState: state }, clipboard: { copy: vi.fn() }, modelId: 'parakeet-tdt-0.6b-v3', createModelStore: () => store }), { initialProps: { state: { kind: 'idle' } as CaptureState } });
    await act(async () => { await result.current.start(); });
    const requestId = invoke.mock.calls.find(([c]) => c === 'stt_prepare')![1].requestId;
    if (ending === 'no-audio') rerender({ state: { kind: 'stopped', audio: undefined } });
    if (ending === 'capture-error') rerender({ state: { kind: 'error', category: 'capture-unavailable', message: 'mic failed' } });
    if (ending === 'capture-cancelled') rerender({ state: { kind: 'cancelled' } });
    if (ending === 'supersede') await act(async () => { await result.current.start(); });
    if (ending === 'unmount') unmount();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(ending === 'unmount' ? 'stt_cancel' : 'stt_release', { requestId }));
    expect(invoke.mock.calls.some(([c]) => c === 'stt_transcribe')).toBe(false);
  });
  it('cancels the exact pending preparation and allows an immediate successor', async () => {
    const store = createMockSttModelStore();
    await store.download('parakeet-tdt-0.6b-v2');
    let admit!: () => void;
    let first = true;
    invoke.mockImplementation((command: string) => {
      if (command === 'stt_prepare' && first) {
        first = false;
        return new Promise<void>((resolve) => { admit = resolve; });
      }
      return Promise.resolve();
    });
    const mic = capture({ kind: 'idle' });
    const history = vi.fn();
    const { result } = renderHook(() => useDogfoodCapture({ captureApi: mic, clipboard: { copy: vi.fn() }, modelId: 'parakeet-tdt-0.6b-v2', createModelStore: () => store, onHistoryRecord: history }));
    let starting!: Promise<void>;
    act(() => { starting = result.current.start(); });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('stt_prepare', expect.anything()));
    const oldId = invoke.mock.calls.find(([c]) => c === 'stt_prepare')![1].requestId;
    act(() => result.current.cancel());
    await act(async () => { await result.current.start(); });
    const newId = invoke.mock.calls.filter(([c]) => c === 'stt_prepare')[1][1].requestId;
    expect(newId).not.toBe(oldId);
    await act(async () => { admit(); await starting; });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('stt_cancel', { requestId: oldId }));
    expect(invoke).not.toHaveBeenCalledWith('stt_cancel', { requestId: newId });
    expect(mic.startFullCaptureSession).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe('recording');
    expect(history).not.toHaveBeenCalled();
  });
  beforeEach(() => { invoke.mockReset().mockResolvedValue(undefined); });
  it.each(['parakeet-tdt-0.6b-v2', 'parakeet-tdt-0.6b-v3'])('prepares %s at start, captures before readiness, and transcribes the frozen model after stop', async (model) => {
    const store = createMockSttModelStore();
    await store.download(model);
    await store.download('whisper-tiny.en');
    let finish!: (value: unknown) => void;
    invoke.mockImplementation((command: string) => command === 'stt_transcribe' ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve());
    const mic = capture({ kind: 'idle' });
    const history = vi.fn();
    const copy = vi.fn();
    const { result, rerender } = renderHook(({ state, modelId }: { state: CaptureState; modelId: string }) => useDogfoodCapture({
      captureApi: { ...mic, captureState: state }, clipboard: { copy }, createModelStore: () => store, modelId, onHistoryRecord: history,
    }), { initialProps: { state: { kind: 'idle' } as CaptureState, modelId: model } });
    await act(async () => { await result.current.start(); });
    expect(invoke).toHaveBeenCalledWith('stt_prepare', { modelId: model, requestId: expect.any(String) });
    const requestId = invoke.mock.calls.find(([c]) => c === 'stt_prepare')![1].requestId;
    expect(mic.startFullCaptureSession).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe('recording');
    expect(invoke.mock.calls.some(([c]) => c === 'stt_transcribe')).toBe(false);
    rerender({ state: { kind: 'active', device: 'Mic', generation: 1, request_id: 'capture' }, modelId: 'whisper-tiny.en' });
    await act(async () => { await result.current.stop(); });
    rerender({ state: { kind: 'stopped', audio }, modelId: 'whisper-tiny.en' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('stt_transcribe', { modelId: model, bufferId: audio.id, requestId, filter: null }));
    expect(result.current.phase).toBe('transcribing');
    expect(history).not.toHaveBeenCalled();
    await act(async () => { finish({ text: 'hello', rawText: 'hello', language: model.endsWith('v3') ? null : 'en' }); });
    await waitFor(() => expect(history).toHaveBeenCalledWith(expect.objectContaining({ model })));
  });
});
