import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

// Global mock: Tauri API is unavailable in jsdom.
// captureService.test.ts and useCaptureState.test.ts declare their own
// vi.mock for @tauri-apps/api/core and @tauri-apps/api/event, which take
// precedence within those files. This global ensures other test files that
// import components using the capture hook do not crash on missing Tauri.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// Global mock: capture state hook — authorized, idle by default.
// Tests that need different permission states declare their own vi.mock.
vi.mock("../../src/services/capture/useCaptureState", () => ({
  useCaptureState: () => ({
    captureState: { kind: "idle" },
    devices: [],
    permissionStatus: "authorized",
    requestMicPermission: vi.fn(),
    runMicTest: vi.fn().mockResolvedValue(undefined),
    stopMicTest: vi.fn(),
  }),
}));

// Note: captureService is NOT globally mocked here.
// Component tests that use captureService (Settings.test.tsx) mock it
// per-file. captureService.test.ts mocks @tauri-apps/api/* directly and
// imports the real captureService module to verify IPC call details.

afterEach(cleanup);

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    addEventListener: vi.fn(),
    matches: false,
    media: query,
    removeEventListener: vi.fn(),
  })),
});
