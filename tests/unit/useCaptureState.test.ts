import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancelCapture: vi.fn(),
  createCaptureRequestId: vi.fn(),
  getCaptureStatus: vi.fn(),
  isTauriEnv: vi.fn(),
  listDevices: vi.fn(),
  onCaptureEvent: vi.fn(),
  queryPermission: vi.fn(),
  requestPermission: vi.fn(),
  startMicTest: vi.fn(),
}));

vi.unmock("../../src/services/capture/useCaptureState");
vi.mock("../../src/services/capture/captureService", () => mocks);

import type { CaptureEvent } from
  "../../src/services/capture/types";
import { useCaptureState } from
  "../../src/services/capture/useCaptureState";

function deferred<T>() {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    reject = onReject;
    resolve = onResolve;
  });
  return { promise, reject, resolve };
}

describe("useCaptureState request ownership", () => {
  let handler: ((event: CaptureEvent) => void) | null;
  let nextId: number;
  let unlisten: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = null;
    nextId = 1;
    unlisten = vi.fn();
    mocks.cancelCapture.mockResolvedValue(true);
    mocks.createCaptureRequestId.mockImplementation(
      () => `request-${nextId++}`,
    );
    mocks.getCaptureStatus.mockResolvedValue(null);
    mocks.isTauriEnv.mockReturnValue(true);
    mocks.listDevices.mockResolvedValue([]);
    mocks.onCaptureEvent.mockImplementation(async (callback) => {
      handler = callback;
      return unlisten;
    });
    mocks.queryPermission.mockResolvedValue(undefined);
    mocks.requestPermission.mockResolvedValue(undefined);
    mocks.startMicTest.mockImplementation(async (requestId) => ({
      generation: 7,
      mode: "test",
      request_id: requestId,
    }));
  });

  it("waits for listener readiness before starting", async () => {
    const listener = deferred<() => void>();
    mocks.onCaptureEvent.mockReturnValue(listener.promise);
    const { result } = renderHook(() => useCaptureState());

    let run!: Promise<void>;
    act(() => { run = result.current.runMicTest(); });
    expect(result.current.captureState).toMatchObject({
      kind: "test-running",
      request_id: "request-1",
    });
    expect(mocks.startMicTest).not.toHaveBeenCalled();

    listener.resolve(unlisten as () => void);
    await act(async () => { await run; });
    expect(mocks.startMicTest).toHaveBeenCalledWith(
      "request-1",
      undefined,
    );
  });

  it("blocks a duplicate start before invoking IPC", async () => {
    const start = deferred<{
      generation: number;
      mode: "test";
      request_id: string;
    }>();
    mocks.startMicTest.mockReturnValue(start.promise);
    const { result } = renderHook(() => useCaptureState());
    await act(async () => {});

    act(() => {
      void result.current.runMicTest();
      void result.current.runMicTest();
    });
    await waitFor(() => expect(mocks.startMicTest).toHaveBeenCalledOnce());
    start.resolve({
      generation: 3,
      mode: "test",
      request_id: "request-2",
    });
  });

  it("does not resurrect state after terminal-before-response", async () => {
    const start = deferred<{
      generation: number;
      mode: "test";
      request_id: string;
    }>();
    mocks.startMicTest.mockReturnValue(start.promise);
    const { result } = renderHook(() => useCaptureState());
    await act(async () => {});
    act(() => { void result.current.runMicTest(); });
    await waitFor(() => expect(mocks.startMicTest).toHaveBeenCalledOnce());

    const requestId = mocks.startMicTest.mock.calls[0][0];
    const metadata = {
      detected_activity: true,
      duration_secs: 1,
      frame_count: 16_000,
      peak_level: 0.5,
    };
    act(() => handler?.({
      generation: 4,
      kind: "test-complete",
      metadata,
      request_id: requestId,
    }));
    expect(result.current.captureState.kind).toBe("test-complete");

    start.resolve({
      generation: 4,
      mode: "test",
      request_id: requestId,
    });
    await act(async () => {});
    expect(result.current.captureState.kind).toBe("test-complete");
  });

  it("ignores a mismatched generation for the owned request", async () => {
    const { result } = renderHook(() => useCaptureState());
    await act(async () => {});
    await act(async () => { await result.current.runMicTest(); });
    expect(result.current.captureState).toMatchObject({
      generation: 7,
      kind: "test-running",
    });

    const requestId = mocks.startMicTest.mock.calls[0][0];
    act(() => handler?.({
      category: "capture-unavailable",
      generation: 6,
      kind: "capture-error",
      message: "stale",
      request_id: requestId,
    }));
    expect(result.current.captureState.kind).toBe("test-running");
  });

  it("cancels a pending response by request ID without resurrection",
    async () => {
      const start = deferred<{
        generation: number;
        mode: "test";
        request_id: string;
      }>();
      mocks.startMicTest.mockReturnValue(start.promise);
      const { result } = renderHook(() => useCaptureState());
      await act(async () => {});
      act(() => { void result.current.runMicTest(); });
      await waitFor(() => expect(mocks.startMicTest).toHaveBeenCalledOnce());
      const requestId = mocks.startMicTest.mock.calls[0][0];

      act(() => result.current.stopMicTest());
      expect(mocks.cancelCapture).toHaveBeenCalledWith(requestId);
      start.resolve({
        generation: 8,
        mode: "test",
        request_id: requestId,
      });
      await act(async () => {});
      expect(result.current.captureState.kind).toBe("idle");
    });

  it("fails closed when listener registration rejects", async () => {
    mocks.onCaptureEvent.mockRejectedValue(new Error("listener denied"));
    const { result } = renderHook(() => useCaptureState());
    await waitFor(() => {
      expect(result.current.captureState.kind).toBe("error");
    });

    await act(async () => { await result.current.runMicTest(); });
    expect(mocks.startMicTest).not.toHaveBeenCalled();
    expect(result.current.captureState).toMatchObject({
      category: "capture-unavailable",
      kind: "error",
    });
  });

  it("creates a fresh listener gate after a failed mount", async () => {
    mocks.onCaptureEvent.mockRejectedValueOnce(
      new Error("listener denied"),
    );
    const first = renderHook(() => useCaptureState());
    await waitFor(() => {
      expect(first.result.current.captureState.kind).toBe("error");
    });
    first.unmount();

    mocks.onCaptureEvent.mockImplementation(async (callback) => {
      handler = callback;
      return unlisten;
    });
    const second = renderHook(() => useCaptureState());
    await act(async () => {});
    await act(async () => {
      await second.result.current.runMicTest();
    });
    expect(mocks.startMicTest).toHaveBeenCalledOnce();
    expect(second.result.current.captureState.kind)
      .toBe("test-running");
  });

  it("normalizes a rejected busy start", async () => {
    mocks.startMicTest.mockRejectedValue(new Error("busy"));
    const { result } = renderHook(() => useCaptureState());
    await act(async () => {});
    await act(async () => { await result.current.runMicTest(); });
    expect(result.current.captureState).toEqual({
      category: "busy",
      kind: "error",
      message: "A capture session is already active.",
    });
  });

  it("adopts exact native status on remount and cancels its owner",
    async () => {
      mocks.getCaptureStatus.mockResolvedValue({
        generation: 12,
        mode: "test",
        request_id: "native-owner",
      });
      const { result, unmount } = renderHook(() => useCaptureState());
      await waitFor(() => {
        expect(result.current.captureState).toMatchObject({
          generation: 12,
          kind: "test-running",
          request_id: "native-owner",
        });
      });
      unmount();
      expect(mocks.cancelCapture).toHaveBeenCalledWith("native-owner");
      await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
    });

  it("unmount before subscription resolves cancels only its request",
    async () => {
      const listener = deferred<() => void>();
      mocks.onCaptureEvent.mockReturnValue(listener.promise);
      const first = renderHook(() => useCaptureState());
      act(() => { void first.result.current.runMicTest(); });
      first.unmount();
      expect(mocks.cancelCapture).toHaveBeenCalledWith("request-1");
      expect(mocks.startMicTest).not.toHaveBeenCalled();

      listener.resolve(unlisten as () => void);
      await act(async () => {});
      expect(unlisten).toHaveBeenCalledOnce();
      expect(mocks.cancelCapture).not.toHaveBeenCalledWith("request-2");
    });
});
