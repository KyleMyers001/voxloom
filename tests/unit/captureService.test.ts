/// Tests for capture service IPC wrappers.
///
/// Uses vitest mocks to substitute Tauri API calls without a real runtime.
/// Verifies correct invoke names, parameters, and event subscription setup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @tauri-apps/api/core before imports.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  isCaptureActive,
  listDevices,
  onCaptureEvent,
  queryPermission,
  requestPermission,
  startMicTest,
  stopCapture,
} from "../../src/services/capture/captureService";

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

describe("captureService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queryPermission invokes capture_query_permission", () => {
    mockInvoke.mockResolvedValue(undefined);
    queryPermission();
    expect(mockInvoke).toHaveBeenCalledWith(
      "capture_query_permission",
    );
  });

  it("requestPermission invokes capture_request_permission", () => {
    mockInvoke.mockResolvedValue(undefined);
    requestPermission();
    expect(mockInvoke).toHaveBeenCalledWith(
      "capture_request_permission",
    );
  });

  it("startMicTest invokes capture_start with testMode true", async () => {
    mockInvoke.mockResolvedValue("ok");
    const result = await startMicTest("Mic A");
    expect(result).toBe("ok");
    expect(mockInvoke).toHaveBeenCalledWith("capture_start", {
      preferredDevice: "Mic A",
      testMode: true,
    });
  });

  it("startMicTest sends null preferredDevice when omitted", async () => {
    mockInvoke.mockResolvedValue("ok");
    await startMicTest();
    expect(mockInvoke).toHaveBeenCalledWith("capture_start", {
      preferredDevice: null,
      testMode: true,
    });
  });

  it("stopCapture invokes capture_stop", () => {
    mockInvoke.mockResolvedValue(undefined);
    stopCapture();
    expect(mockInvoke).toHaveBeenCalledWith("capture_stop");
  });

  it("isCaptureActive returns the invoke result", async () => {
    mockInvoke.mockResolvedValue(true);
    const active = await isCaptureActive();
    expect(active).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith("capture_is_active");
  });

  it("listDevices returns device names from invoke", async () => {
    mockInvoke.mockResolvedValue(["Mic A", "Mic B"]);
    const names = await listDevices();
    expect(names).toEqual(["Mic A", "Mic B"]);
    expect(mockInvoke).toHaveBeenCalledWith("capture_list_devices");
  });

  it("onCaptureEvent calls listen with correct channel", async () => {
    const unlisten = vi.fn();
    mockListen.mockResolvedValue(unlisten);
    const handler = vi.fn();
    const result = await onCaptureEvent(handler);
    expect(mockListen).toHaveBeenCalledWith(
      "capture:event",
      expect.any(Function),
    );
    expect(result).toBe(unlisten);
  });

  it("onCaptureEvent passes payload to handler", async () => {
    const handler = vi.fn();
    let capturedCallback: ((e: { payload: unknown }) => void) | null =
      null;
    mockListen.mockImplementation(
      async (_channel, cb) => {
        capturedCallback = cb as typeof capturedCallback;
        return () => {};
      },
    );
    await onCaptureEvent(handler);
    capturedCallback!({
      payload: { kind: "capture-stopped" },
    });
    expect(handler).toHaveBeenCalledWith({ kind: "capture-stopped" });
  });
});
