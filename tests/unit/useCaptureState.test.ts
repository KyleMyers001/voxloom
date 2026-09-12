/// Tests for useCaptureState hook.
///
/// This file un-mocks useCaptureState (which is globally mocked in setup.ts)
/// and uses the real implementation, but mocks the Tauri API calls so the
/// hook can run in jsdom without a real Tauri runtime.
import {
  act,
  cleanup,
  renderHook,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Un-mock useCaptureState so we can test the real implementation.
vi.unmock("../../src/services/capture/useCaptureState");

// The hook imports from captureService which imports from @tauri-apps/api.
// The global setup.ts mocks handle those, but we need to ensure the
// captureService functions behave correctly for our event-driven tests.
// We override captureService with controlled stubs.
vi.mock("../../src/services/capture/captureService", () => {
  type EventHandler = (e: { payload: unknown }) => void;
  let handler: EventHandler | null = null;
  const unlisten = vi.fn();

  return {
    isCaptureActive: vi.fn().mockResolvedValue(false),
    listDevices: vi.fn().mockResolvedValue([]),
    onCaptureEvent: vi.fn().mockImplementation(
      async (cb: (event: unknown) => void) => {
        handler = (e: { payload: unknown }) => cb(e.payload);
        return unlisten;
      },
    ),
    queryPermission: vi.fn(),
    requestPermission: vi.fn(),
    startMicTest: vi.fn().mockResolvedValue("ok"),
    stopCapture: vi.fn(),
    // Expose the handler so tests can emit events.
    __getHandler: () => handler,
  };
});

import { useCaptureState } from
  "../../src/services/capture/useCaptureState";

// Retrieve the simulated event emitter.
async function getEmitter() {
  const mod = await import(
    "../../src/services/capture/captureService"
  );
  return (mod as unknown as {
    __getHandler: () => ((e: { payload: unknown }) => void) | null;
  }).__getHandler;
}

function emit(payload: unknown, handler: ((e: { payload: unknown }) => void) | null) {
  if (handler) {
    act(() => handler({ payload }));
  }
}

describe("useCaptureState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("starts with idle capture state and null permission", async () => {
    const { result } = renderHook(() => useCaptureState());
    expect(result.current.captureState.kind).toBe("idle");
    expect(result.current.permissionStatus).toBeNull();
  });

  it("updates permission from permission-status event", async () => {
    const getHandler = await getEmitter();
    const { result } = renderHook(() => useCaptureState());
    // Allow useEffect to run.
    await act(async () => {});
    const h = getHandler();
    emit({ kind: "permission-status", status: "authorized" }, h);
    expect(result.current.permissionStatus).toBe("authorized");
  });

  it("sets idle state when permission denied", async () => {
    const getHandler = await getEmitter();
    const { result } = renderHook(() => useCaptureState());
    await act(async () => {});
    const h = getHandler();
    emit({ kind: "permission-status", status: "denied" }, h);
    expect(result.current.permissionStatus).toBe("denied");
    expect(result.current.captureState.kind).toBe("idle");
  });

  it("sets active state on capture-started", async () => {
    const getHandler = await getEmitter();
    const { result } = renderHook(() => useCaptureState());
    await act(async () => {});
    const h = getHandler();
    emit({ device_name: "Built-in Mic", kind: "capture-started" }, h);
    expect(result.current.captureState).toEqual({
      device: "Built-in Mic",
      kind: "active",
    });
  });

  it("returns to idle on capture-stopped", async () => {
    const getHandler = await getEmitter();
    const { result } = renderHook(() => useCaptureState());
    await act(async () => {});
    const h = getHandler();
    emit({ device_name: "Mic", kind: "capture-started" }, h);
    emit({ kind: "capture-stopped" }, h);
    expect(result.current.captureState.kind).toBe("idle");
  });

  it("sets test-complete with metadata on test-complete event",
    async () => {
      const getHandler = await getEmitter();
      const { result } = renderHook(() => useCaptureState());
      await act(async () => {});
      const h = getHandler();
      const metadata = {
        detected_activity: true,
        duration_secs: 3.2,
        frame_count: 51_200,
        peak_level: 0.42,
      };
      emit({ kind: "test-complete", metadata }, h);
      expect(result.current.captureState).toEqual({
        kind: "test-complete",
        metadata,
      });
    });

  it("sets error state on capture-error", async () => {
    const getHandler = await getEmitter();
    const { result } = renderHook(() => useCaptureState());
    await act(async () => {});
    const h = getHandler();
    emit({
      category: "permission-denied",
      kind: "capture-error",
      message: "Permission denied.",
    }, h);
    expect(result.current.captureState).toMatchObject({
      category: "permission-denied",
      kind: "error",
    });
  });

  it("populates devices on device-list event", async () => {
    const getHandler = await getEmitter();
    const { result } = renderHook(() => useCaptureState());
    await act(async () => {});
    const h = getHandler();
    emit({ devices: ["Mic A", "Mic B"], kind: "device-list" }, h);
    expect(result.current.devices).toEqual(["Mic A", "Mic B"]);
  });

  it("stale events after unmount do not crash or update", async () => {
    const getHandler = await getEmitter();
    const { result, unmount } = renderHook(() => useCaptureState());
    await act(async () => {});
    const h = getHandler();
    unmount();
    // Emitting after unmount must not throw.
    expect(() => {
      emit({ kind: "capture-stopped" }, h);
    }).not.toThrow();
    // State is unchanged from before unmount.
    expect(result.current.captureState.kind).toBe("idle");
  });

  it("stopMicTest resets state to idle", async () => {
    const getHandler = await getEmitter();
    const { result } = renderHook(() => useCaptureState());
    await act(async () => {});
    const h = getHandler();
    emit({ device_name: "Mic", kind: "capture-started" }, h);
    act(() => { result.current.stopMicTest(); });
    expect(result.current.captureState.kind).toBe("idle");
  });

  it("runMicTest sets test-running state while IPC is in flight",
    async () => {
      let resolveInvoke!: (v: string) => void;
      const captureService = await import(
        "../../src/services/capture/captureService"
      );
      vi.mocked(
        (captureService as unknown as { startMicTest: () => Promise<string> })
          .startMicTest,
      ).mockReturnValueOnce(
        new Promise((res) => { resolveInvoke = res; }),
      );

      const { result } = renderHook(() => useCaptureState());
      await act(async () => {});

      // Don't await runMicTest so we can check intermediate state.
      act(() => { void result.current.runMicTest(); });
      expect(result.current.captureState.kind).toBe("test-running");

      // Resolve the promise.
      act(() => resolveInvoke("ok"));
    });
});
