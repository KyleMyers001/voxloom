import { StrictMode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { UseCaptureStateResult } from '../../../src/services/capture/useCaptureState';
import { createMockSttModelStore } from '../../../src/services/stt/mockStt';
import { useDogfoodCapture } from '../../../src/services/stt/useDogfoodCapture';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../../../src/services/capture/useCaptureState', () => ({
  useCaptureState: vi.fn(),
}));

it('recreates the default native owner across StrictMode setup and remount', async () => {
  let owner = 0;
  invoke.mockImplementation(async (command: string) => {
    if (command === 'cleanup_session_open') return String(++owner);
  });
  const store = createMockSttModelStore();
  await store.download('whisper-tiny.en');
  const captureApi: UseCaptureStateResult = {
    cancelActiveCapture: vi.fn(),
    captureReady: true,
    captureState: { kind: 'idle' },
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
  const render = () => renderHook(() => useDogfoodCapture({
    captureApi,
    cleanupEnabled: true,
    cleanupModelId: 'qwen3-0.6b-q4-k-m',
    clipboard: { copy: vi.fn().mockResolvedValue(undefined) },
    createModelStore: () => store,
    modelId: 'whisper-tiny.en',
  }), { wrapper: StrictMode });
  const first = render();
  expect(invoke).not.toHaveBeenCalled();
  await act(async () => { await first.result.current.start(); });
  expect(invoke).toHaveBeenCalledWith('cleanup_acquire', expect.objectContaining({ sessionId: '1' }));
  first.unmount();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('cleanup_session_dispose', { sessionId: '1' }));
  const second = render();
  await act(async () => { await second.result.current.start(); });
  expect(invoke).toHaveBeenCalledWith('cleanup_acquire', expect.objectContaining({ sessionId: '2' }));
  expect(owner).toBe(2);
  second.unmount();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('cleanup_session_dispose', { sessionId: '2' }));
});
