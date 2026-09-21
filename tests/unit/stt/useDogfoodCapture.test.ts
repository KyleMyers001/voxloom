/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ClipboardAdapter } from "../../../src/services/clipboard";
import type { CaptureState } from "../../../src/services/capture/types";
import type { UseCaptureStateResult } from
  "../../../src/services/capture/useCaptureState";
import {
  createMockSttEngine,
  createMockSttModelStore,
} from "../../../src/services/stt/mockStt";
import { useDogfoodCapture } from
  "../../../src/services/stt/useDogfoodCapture";

function clipboard(): ClipboardAdapter {
  return { copy: vi.fn().mockResolvedValue(undefined) };
}

function stubCapture(state: CaptureState): UseCaptureStateResult {
  return {
    cancelActiveCapture: vi.fn(),
    captureReady: true,
    captureState: state,
    deviceListError: null,
    devices: [],
    devicesLoading: false,
    permissionStatus: "authorized",
    prepareDeviceChange: vi.fn().mockResolvedValue(true),
    refreshDevices: vi.fn().mockResolvedValue(undefined),
    requestMicPermission: vi.fn(),
    runMicTest: vi.fn(),
    startFullCaptureSession: vi.fn(),
    stopFullCapture: vi.fn(),
    stopMicTest: vi.fn(),
  };
}

describe("useDogfoodCapture", () => {
  it("auto-runs dogfoodTranscribeAndCopy after clean stop with audio", async () => {
    const clip = clipboard();
    const store = createMockSttModelStore();
    await store.download("whisper-tiny.en");

    const dogfood = vi.fn(async ({ modelId, audio }) => {
      const engine = createMockSttEngine({ modelId });
      return engine.transcribe({
        durationMs: audio.duration_ms,
        id: audio.id,
        sampleRateHz: audio.sample_rate_hz,
      });
    });

    let captureState: CaptureState = { kind: "idle" };
    const startFullCaptureSession = vi.fn(async () => {
      captureState = {
        device: "Mic",
        generation: 1,
        kind: "active",
        request_id: "full-1",
      };
    });
    const stopFullCapture = vi.fn(async () => {
      captureState = {
        audio: {
          duration_ms: 900,
          id: "pcm-dogfood-1",
          sample_rate_hz: 16_000,
        },
        kind: "stopped",
      };
    });

    const { result, rerender } = renderHook(
      ({ state }: { state: CaptureState }) => useDogfoodCapture({
        captureApi: {
          ...stubCapture(state),
          startFullCaptureSession: async () => {
            await startFullCaptureSession();
          },
          stopFullCapture: async () => {
            await stopFullCapture();
          },
        },
        clipboard: clip,
        createModelStore: () => store,
        dogfood: dogfood as never,
        modelId: "whisper-tiny.en",
      }),
      { initialProps: { state: captureState } },
    );

    await act(async () => {
      await result.current.start();
    });
    rerender({ state: captureState });
    expect(result.current.phase).toBe("recording");
    expect(startFullCaptureSession).toHaveBeenCalledOnce();

    await act(async () => {
      await result.current.stop();
    });
    rerender({ state: captureState });

    await waitFor(() => expect(dogfood).toHaveBeenCalledOnce());
    expect(dogfood).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.objectContaining({ id: "pcm-dogfood-1" }),
        modelId: "whisper-tiny.en",
      }),
    );
    await waitFor(() => expect(result.current.phase).toBe("success"));
  });

  it("errors clearly when the selected model is not downloaded", async () => {
    const store = createMockSttModelStore();
    const dogfood = vi.fn();
    const toast = vi.fn();

    const { result } = renderHook(() => useDogfoodCapture({
      captureApi: stubCapture({ kind: "idle" }),
      clipboard: clipboard(),
      createModelStore: () => store,
      dogfood: dogfood as never,
      modelId: "whisper-tiny.en",
      onToast: toast,
    }));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.phase).toBe("error");
    expect(result.current.message).toMatch(/not downloaded/i);
    expect(result.current.message).toMatch(/no silent download/i);
    expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/not downloaded/i),
    );
    expect(dogfood).not.toHaveBeenCalled();
  });

  it("cancel discards without calling dogfood STT", async () => {
    const store = createMockSttModelStore();
    await store.download("whisper-tiny.en");
    const dogfood = vi.fn();
    let captureState: CaptureState = { kind: "idle" };
    const cancelActiveCapture = vi.fn(() => {
      captureState = { kind: "cancelled" };
    });
    const startFullCaptureSession = vi.fn(async () => {
      captureState = {
        device: "Mic",
        generation: 1,
        kind: "active",
        request_id: "full-2",
      };
    });

    const { result, rerender } = renderHook(
      ({ state }: { state: CaptureState }) => useDogfoodCapture({
        captureApi: {
          ...stubCapture(state),
          cancelActiveCapture,
          startFullCaptureSession,
        },
        clipboard: clipboard(),
        createModelStore: () => store,
        dogfood: dogfood as never,
        modelId: "whisper-tiny.en",
      }),
      { initialProps: { state: captureState } },
    );

    await act(async () => {
      await result.current.start();
    });
    rerender({ state: captureState });

    act(() => {
      result.current.cancel();
    });
    rerender({ state: captureState });

    expect(cancelActiveCapture).toHaveBeenCalledOnce();
    expect(dogfood).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("cancelled");
  });
});
