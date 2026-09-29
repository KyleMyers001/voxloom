import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// Global mock: Tauri API is unavailable in jsdom.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  // isTauri() returns false in jsdom (no real Tauri runtime).
  isTauri: vi.fn().mockReturnValue(false),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// Global mock: capture state hook — authorized, idle by default.
// Tests that need different permission states declare their own vi.mock.
vi.mock('../../src/services/capture/useCaptureState', () => ({
  useCaptureState: () => ({
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
    runMicTest: vi.fn().mockResolvedValue(undefined),
    startFullCaptureSession: vi.fn().mockResolvedValue('started'),
    stopFullCapture: vi.fn().mockResolvedValue(undefined),
    stopMicTest: vi.fn(),
  }),
}));

// Global mock: captureService — prevents live IPC in component tests.
// Settings.test.tsx and similar override per-file as needed.
// captureService.test.ts re-mocks @tauri-apps/api/* and uses the real
// captureService module to verify IPC call structure.
vi.mock('../../src/services/capture/captureService', () => ({
  cancelCapture: vi.fn().mockResolvedValue(true),
  createCaptureRequestId: vi.fn().mockReturnValue('request-id'),
  getCaptureStatus: vi.fn().mockResolvedValue(null),
  // Returns false in jsdom: Onboarding shows browser-unavailable note.
  // Onboarding.test.tsx overrides with its own vi.mock for permission tests.
  isTauriEnv: vi.fn().mockReturnValue(false),
  listDevices: vi.fn().mockResolvedValue([]),
  onCaptureEvent: vi.fn().mockResolvedValue(() => {}),
  queryPermission: vi.fn(),
  requestPermission: vi.fn(),
  startFullCapture: vi.fn().mockResolvedValue({
    generation: 1,
    mode: 'full',
    request_id: 'request-id',
  }),
  startMicTest: vi.fn().mockResolvedValue({
    generation: 1,
    mode: 'test',
    request_id: 'request-id',
  }),
  stopCapture: vi.fn().mockResolvedValue(undefined),
}));

afterEach(cleanup);

beforeEach(() => {
  if (typeof navigator !== 'undefined') {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  }
});

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      matches: false,
      media: query,
      removeEventListener: vi.fn(),
    })),
  });
}
