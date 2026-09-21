import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../../src/services/capture/captureService");
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  cancelCapture,
  createCaptureRequestId,
  getCaptureStatus,
  listDevices,
  onCaptureEvent,
  queryPermission,
  requestPermission,
  startFullCapture,
  startMicTest,
} from "../../src/services/capture/captureService";

const mockInvoke = vi.mocked(invoke);
const mockIsTauri = vi.mocked(isTauri);
const mockListen = vi.mocked(listen);

describe("captureService in Tauri", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTauri.mockReturnValue(true);
  });

  it("uses unique synchronous request IDs", () => {
    const first = createCaptureRequestId();
    const second = createCaptureRequestId();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^capture-\d+-\d+$/);
  });

  it("correlates permission commands", async () => {
    mockInvoke.mockResolvedValue(undefined);
    await queryPermission("query-id");
    await requestPermission("permission-id");
    expect(mockInvoke).toHaveBeenNthCalledWith(
      1,
      "capture_query_permission",
      { requestId: "query-id" },
    );
    expect(mockInvoke).toHaveBeenNthCalledWith(
      2,
      "capture_request_permission",
      { requestId: "permission-id" },
    );
  });

  it("starts and cancels by the same client request ID", async () => {
    const status = {
      generation: 4,
      mode: "test" as const,
      request_id: "request-id",
    };
    mockInvoke.mockResolvedValueOnce(status).mockResolvedValueOnce(true);
    await expect(startMicTest("request-id", "input-1"))
      .resolves.toEqual(status);
    await expect(cancelCapture("request-id")).resolves.toBe(true);
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "capture_start", {
      preferredDeviceId: "input-1",
      requestId: "request-id",
      testMode: true,
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "capture_cancel", {
      requestId: "request-id",
    });
  });


  it("starts a full capture session for STT handoff", async () => {
    const status = {
      generation: 5,
      mode: "full" as const,
      request_id: "full-id",
    };
    mockInvoke.mockResolvedValue(status);
    await expect(startFullCapture("full-id", "input-2"))
      .resolves.toEqual(status);
    expect(mockInvoke).toHaveBeenCalledWith("capture_start", {
      preferredDeviceId: "input-2",
      requestId: "full-id",
      testMode: false,
    });
  });

  it("returns the exact active status", async () => {
    const status = {
      generation: 9,
      mode: "full" as const,
      request_id: "active-id",
    };
    mockInvoke.mockResolvedValue(status);
    await expect(getCaptureStatus()).resolves.toEqual(status);
    expect(mockInvoke).toHaveBeenCalledWith("capture_status");
  });

  it("lists devices and forwards event payloads", async () => {
    const unlisten = vi.fn();
    let callback: ((event: { payload: unknown }) => void) | undefined;
    const devices = [
      { available: true, id: "input-1", label: "Mic A" },
    ];
    mockInvoke.mockResolvedValue(devices);
    mockListen.mockImplementation(async (_event, handler) => {
      callback = handler as typeof callback;
      return unlisten;
    });
    await expect(listDevices()).resolves.toEqual(devices);
    const handler = vi.fn();
    await expect(onCaptureEvent(handler)).resolves.toBe(unlisten);
    callback?.({
      payload: {
        generation: 0,
        kind: "permission-status",
        request_id: "permission-1",
        status: "authorized",
      },
    });
    expect(handler).toHaveBeenCalledWith({
      generation: 0,
      kind: "permission-status",
      request_id: "permission-1",
      status: "authorized",
    });
  });
});

describe("captureService in a browser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTauri.mockReturnValue(false);
  });

  it("fails capture closed without invoking native IPC", async () => {
    await expect(startMicTest("request-id"))
      .rejects.toThrow("capture-unavailable");
    await expect(cancelCapture("request-id")).resolves.toBe(false);
    await expect(getCaptureStatus()).resolves.toBeNull();
    await expect(listDevices()).resolves.toEqual([]);
    await queryPermission("query-id");
    await requestPermission("permission-id");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("does not register a native listener", async () => {
    const unlisten = await onCaptureEvent(vi.fn());
    expect(mockListen).not.toHaveBeenCalled();
    expect(() => unlisten()).not.toThrow();
  });
});
