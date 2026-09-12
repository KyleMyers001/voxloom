/// Tests for capture service IPC wrappers.
///
/// Sets window.__TAURI__ to activate the Tauri path, then uses the
/// mocked @tauri-apps/api/core from setup.ts. Also verifies
/// non-Tauri (browser) guard behaviour.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Use the real captureService module, not the global stub from setup.ts.
vi.unmock("../../src/services/capture/captureService");

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  cancelCapture,
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

// ── Tauri path ────────────────────────────────────────────────────────────

describe("captureService (Tauri)", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: {},
      writable: true,
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).__TAURI__;
  });

  it("queryPermission invokes capture_query_permission", () => {
    mockInvoke.mockResolvedValue(undefined);
    queryPermission();
    expect(mockInvoke).toHaveBeenCalledWith("capture_query_permission");
  });

  it("requestPermission invokes capture_request_permission", () => {
    mockInvoke.mockResolvedValue(undefined);
    requestPermission();
    expect(mockInvoke).toHaveBeenCalledWith(
      "capture_request_permission",
    );
  });

  it("startMicTest sends capture_start with testMode true", async () => {
    mockInvoke.mockResolvedValue("1");
    const result = await startMicTest("Mic A");
    expect(result).toBe("1");
    expect(mockInvoke).toHaveBeenCalledWith("capture_start", {
      preferredDevice: "Mic A",
      testMode: true,
    });
  });

  it("startMicTest sends null preferredDevice when omitted", async () => {
    mockInvoke.mockResolvedValue("1");
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

  it("cancelCapture invokes capture_cancel with numeric generation",
    async () => {
      mockInvoke.mockResolvedValue(true);
      const ok = await cancelCapture("3");
      expect(ok).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith("capture_cancel", {
        generation: 3,
      });
    });

  it("cancelCapture returns false for non-numeric generation", async () => {
    const ok = await cancelCapture("bad");
    expect(ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
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

  it("onCaptureEvent registers listener on correct channel", async () => {
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
    let cb: ((e: { payload: unknown }) => void) | null = null;
    mockListen.mockImplementation(async (_ch, fn) => {
      cb = fn as typeof cb;
      return () => {};
    });
    await onCaptureEvent(handler);
    cb!({ payload: { kind: "capture-stopped" } });
    expect(handler).toHaveBeenCalledWith({ kind: "capture-stopped" });
  });
});

// ── Browser (non-Tauri) guard ─────────────────────────────────────────────

describe("captureService (browser)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).__TAURI__;
  });

  it("queryPermission does not invoke IPC", () => {
    queryPermission();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("requestPermission does not invoke IPC", () => {
    requestPermission();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("startMicTest returns capture-unavailable fallback", async () => {
    const result = await startMicTest();
    expect(result).toBe("capture-unavailable");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("isCaptureActive returns false", async () => {
    const active = await isCaptureActive();
    expect(active).toBe(false);
  });

  it("listDevices returns empty array", async () => {
    const devs = await listDevices();
    expect(devs).toEqual([]);
  });

  it("stopCapture is a no-op outside Tauri", () => {
    stopCapture();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("cancelCapture returns false outside Tauri", async () => {
    const ok = await cancelCapture("1");
    expect(ok).toBe(false);
  });

  it("onCaptureEvent returns no-op unlisten", async () => {
    const unlisten = await onCaptureEvent(vi.fn());
    expect(mockListen).not.toHaveBeenCalled();
    expect(() => unlisten()).not.toThrow();
  });
});
