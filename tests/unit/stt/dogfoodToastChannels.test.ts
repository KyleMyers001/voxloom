/** BUS-91: each dogfood message goes through its intended toast channel. */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptureState } from '../../../src/services/capture/types';
import type { UseCaptureStateResult } from '../../../src/services/capture/useCaptureState';
import * as cancelScopeModule from '../../../src/services/shortcut/cancelScope';
import { cancelUnavailableHint } from '../../../src/services/shortcut/cancelUnavailable';
import type { DogfoodResult } from '../../../src/services/stt/dogfoodPath';
import { createMockSttModelStore } from '../../../src/services/stt/mockStt';
import { errorText, useDogfoodCapture } from '../../../src/services/stt/useDogfoodCapture';

const AUDIO = { duration_ms: 700, id: 'pcm-1', sample_rate_hz: 16_000 };

function stubCapture(): UseCaptureStateResult {
  return {
    cancelActiveCapture: vi.fn(), captureReady: true, captureState: { kind: 'idle' },
    deviceListError: null, devices: [], devicesLoading: false, permissionStatus: 'authorized',
    prepareDeviceChange: vi.fn().mockResolvedValue(true),
    refreshDevices: vi.fn().mockResolvedValue(undefined), requestMicPermission: vi.fn(),
    runMicTest: vi.fn(), startFullCaptureSession: vi.fn().mockResolvedValue('started'),
    stopFullCapture: vi.fn().mockResolvedValue(undefined), stopMicTest: vi.fn(),
    waitForCaptureRelease: vi.fn().mockResolvedValue(undefined),
  };
}

async function setup(
  { capture = stubCapture(), dogfood, downloaded = true }: {
    capture?: UseCaptureStateResult;
    dogfood?: () => Promise<DogfoodResult>;
    downloaded?: boolean;
  } = {},
) {
  const store = createMockSttModelStore();
  if (downloaded) await store.download('whisper-tiny.en');
  const toast = vi.fn();
  const errorToast = vi.fn();
  const hook = renderHook(({ state }: { state: CaptureState }) => useDogfoodCapture({
    captureApi: { ...capture, captureState: state }, clipboard: { copy: vi.fn() },
    createModelStore: () => store, dogfood: dogfood as never, modelId: 'whisper-tiny.en',
    onErrorToast: errorToast, onToast: toast,
  }), { initialProps: { state: { kind: 'idle' } as CaptureState } });
  /** The message reached the error toast only, never the plain toast. */
  const expectErrorOnly = (text: string) => {
    expect(errorToast).toHaveBeenCalledWith(text);
    expect(toast).not.toHaveBeenCalledWith(text);
    expect(hook.result.current.phase).toBe('error');
  };
  return { ...hook, capture, errorToast, expectErrorOnly, toast };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('dogfood toast channels (BUS-91)', () => {
  it('announces a missing model as an error', async () => {
    const { expectErrorOnly, result } = await setup({ downloaded: false });
    await act(async () => { await result.current.start(); });
    expectErrorOnly(result.current.message ?? '');
    expect(result.current.message).toMatch(/not downloaded/);
  });

  it('announces a capture start failure as an error', async () => {
    const capture = stubCapture();
    capture.startFullCaptureSession = vi.fn().mockRejectedValue(new Error('mic exploded'));
    const { expectErrorOnly, result } = await setup({ capture });
    await act(async () => { await result.current.start(); });
    expectErrorOnly(errorText(new Error('mic exploded')));
    expect(result.current.message).toBe(errorText(new Error('mic exploded')));
  });

  it('announces a stop failure as an error', async () => {
    const capture = stubCapture();
    capture.stopFullCapture = vi.fn().mockRejectedValue(new Error('stop failed'));
    const { expectErrorOnly, result } = await setup({ capture });
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    expectErrorOnly(errorText(new Error('stop failed')));
  });

  it('announces a stop without audio as an error', async () => {
    const { expectErrorOnly, rerender, result } = await setup();
    await act(async () => { await result.current.start(); });
    rerender({ state: { kind: 'stopped' } });
    expectErrorOnly('Capture stopped without audio — nothing to transcribe.');
    expect(result.current.message).toBe('Capture stopped without audio — nothing to transcribe.');
  });

  it('announces a transcription failure as an error', async () => {
    const dogfood = vi.fn().mockRejectedValue(new Error('stt failed'));
    const { expectErrorOnly, rerender, result } = await setup({ dogfood });
    await act(async () => { await result.current.start(); });
    rerender({ state: { audio: AUDIO, kind: 'stopped' } });
    await waitFor(() => expect(result.current.phase).toBe('error'));
    expectErrorOnly(errorText(new Error('stt failed')));
    expect(result.current.message).toBe(errorText(new Error('stt failed')));
  });

  it('error-toasts a superseded session\'s transcription failure', async () => {
    let fail!: (error: Error) => void;
    const dogfood = vi.fn(() => new Promise<DogfoodResult>((_, reject) => { fail = reject; }));
    const { errorToast, rerender, result, toast } = await setup({ dogfood });
    await act(async () => { await result.current.start(); });
    rerender({ state: { audio: AUDIO, kind: 'stopped' } });
    await waitFor(() => expect(dogfood).toHaveBeenCalledOnce());
    rerender({ state: { kind: 'idle' } });
    await act(async () => { await result.current.start(); });
    await act(async () => { fail(new Error('late stt failure')); });
    const text = errorText(new Error('late stt failure'));
    expect(errorToast).toHaveBeenCalledExactlyOnceWith(text);
    expect(toast).not.toHaveBeenCalledWith(text);
    expect(result.current.phase).toBe('recording');
  });

  it('toasts the Escape-cancel hint plainly, after capture starts and Listening…', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(cancelScopeModule, 'beginCancelScope')
      .mockRejectedValueOnce({ code: 'cancel-ax-untrusted', message: 'diagnostic' });
    const { capture, errorToast, result, toast } = await setup();
    await act(async () => { await result.current.start(); });
    const hint = cancelUnavailableHint('cancel-ax-untrusted');
    expect(toast.mock.calls).toEqual([['Listening…'], [hint]]);
    expect(errorToast).not.toHaveBeenCalled();
    const started = vi.mocked(capture.startFullCaptureSession).mock.invocationCallOrder[0];
    expect(started).toBeLessThan(toast.mock.invocationCallOrder[1]);
  });
});
