/** BUS-91: a dogfood hook harness with a native-like Escape scope and stub delivery. */
import { act, renderHook } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import type { CaptureState } from '../../../src/services/capture/types';
import type { UseCaptureStateResult } from '../../../src/services/capture/useCaptureState';
import type { DictationRecord } from '../../../src/domain/types';
import { createStubDeliveryAdapter, type TargetSnapshot } from '../../../src/services/delivery';
import * as cancelScopeModule from '../../../src/services/shortcut/cancelScope';
import { dogfoodTranscribeAndCopy } from '../../../src/services/stt/dogfoodPath';
import { createMockSttEngine, createMockSttModelStore } from '../../../src/services/stt/mockStt';
import { useDogfoodCapture } from '../../../src/services/stt/useDogfoodCapture';

export const EMPTY_STOP = 'Capture stopped without audio — nothing to transcribe.';
export const emptyStop: CaptureState = { kind: 'stopped' };
export const micLost: CaptureState = { category: 'busy', kind: 'error', message: 'mic lost' };
export const tapAudio: CaptureState = {
  audio: { duration_ms: 400, id: 'tap-audio', sample_rate_hz: 16_000 }, kind: 'stopped',
};
const target: TargetSnapshot = {
  appName: 'Notes', appPid: 42, capturedAt: 1, elementId: 'C',
  elementRole: 'AXTextArea', insertable: true, kind: 'insertable', reason: null,
};

/** Like the native scope: closed by finish or dispose, then finish is false. */
function nativeLikeScope() {
  let closed = false;
  return {
    dispose: vi.fn(async () => { closed = true; }),
    finish: vi.fn(async () => { const open = !closed; closed = true; return open; }),
  };
}

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

export async function setup() {
  const scopes: ReturnType<typeof nativeLikeScope>[] = [];
  vi.spyOn(cancelScopeModule, 'beginCancelScope').mockImplementation(async () => {
    scopes.push(nativeLikeScope());
    return scopes[scopes.length - 1];
  });
  const store = createMockSttModelStore();
  await store.download('whisper-tiny.en');
  const capture = stubCapture();
  const onErrorToast: Mock<(message: string) => void> = vi.fn();
  const onHistoryRecord: Mock<(record: DictationRecord) => void> = vi.fn();
  const onToast: Mock<(message: string) => void> = vi.fn();
  const insert: Mock<(text: string) => Promise<void>> = vi.fn(async () => {});
  const transcribe = vi.fn(async () => ({ language: 'en', text: 'tap words' }));
  const clipboard = { copy: vi.fn() };
  const deliveryPlatform = createStubDeliveryAdapter({
    clipboard, insert, snapshot: async () => target, validate: async (intended) => intended,
  });
  const dogfood: typeof dogfoodTranscribeAndCopy = (options) => dogfoodTranscribeAndCopy({
    ...options, createEngine: (modelId) => ({ ...createMockSttEngine({ modelId }), transcribe }),
  });
  const hook = renderHook(({ state }: { state: CaptureState }) => useDogfoodCapture({
    captureApi: { ...capture, captureState: state }, clipboard, createModelStore: () => store,
    deliveryPlatform, dogfood, modelId: 'whisper-tiny.en', onErrorToast, onHistoryRecord,
    onToast,
  }), { initialProps: { state: { kind: 'idle' } as CaptureState } });
  const escape = () => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    act(() => { document.dispatchEvent(event); });
    return event.defaultPrevented;
  };
  return {
    ...hook, capture, escape, insert, onErrorToast, onHistoryRecord, onToast, scopes, transcribe,
  };
}

/** A pending promise and the function that settles it. */
export function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((done) => { settle = done; });
  return { promise, settle };
}
