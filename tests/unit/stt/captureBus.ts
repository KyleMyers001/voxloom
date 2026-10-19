/** BUS-91: a native capture event bus over mocked captureService IPC. */
import { vi, type Mock } from 'vitest';
import type { CaptureEvent } from '../../../src/services/capture/types';

/** The captureService IPC mocks (declare them in the test with `vi.hoisted`). */
export type CaptureMocks = Record<
  | 'cancelCapture' | 'createCaptureRequestId' | 'getCaptureStatus' | 'isTauriEnv' | 'listDevices'
  | 'onCaptureEvent' | 'queryPermission' | 'requestPermission' | 'startFullCapture'
  | 'startMicTest' | 'stopCapture',
  Mock
>;

/** Reset the mocks to a working native side; events reach every mounted hook. */
export function installCaptureBus(mocks: CaptureMocks) {
  vi.clearAllMocks();
  let handlers: ((event: CaptureEvent) => void)[] = [];
  let nextId = 1;
  mocks.cancelCapture.mockResolvedValue(true);
  mocks.createCaptureRequestId.mockImplementation(() => `request-${nextId++}`);
  mocks.getCaptureStatus.mockResolvedValue(null);
  mocks.isTauriEnv.mockReturnValue(true);
  mocks.listDevices.mockResolvedValue([]);
  mocks.onCaptureEvent.mockImplementation(async (callback) => {
    handlers.push(callback);
    return () => { handlers = handlers.filter((item) => item !== callback); };
  });
  mocks.queryPermission.mockResolvedValue(undefined);
  mocks.startFullCapture.mockImplementation(async (requestId) => ({
    generation: 3, mode: 'full', request_id: requestId,
  }));
  mocks.stopCapture.mockResolvedValue(undefined);
  return {
    emit: (event: CaptureEvent) => { for (const listener of handlers) listener(event); },
    listening: () => handlers.length > 0,
    /** The `index`th full capture's request id. */
    requestOf: (index: number) => mocks.startFullCapture.mock.calls[index][0] as string,
    /** The native stop of the `index`th full capture. */
    stopOf: (index: number, id: string): CaptureEvent => ({
      audio: { duration_ms: 400, id, sample_rate_hz: 16_000 }, generation: 3,
      kind: 'capture-stopped', request_id: mocks.startFullCapture.mock.calls[index][0] as string,
    }),
  };
}
