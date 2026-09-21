import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockSttModelStore } from "../../../src/services/stt/mockStt";
import { useSttModels } from "../../../src/services/stt/useSttModels";

describe("useSttModels", () => {
  it("lists models on mount without downloading", async () => {
    const store = createMockSttModelStore();
    const download = vi.spyOn(store, "download");
    const onSelect = vi.fn();

    const { result } = renderHook(() =>
      useSttModels({
        onSelect,
        selectedModelId: "whisper-tiny.en",
        store,
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.models.length).toBeGreaterThan(0);
    expect(result.current.models.every((m) => m.status === "missing")).toBe(
      true,
    );
    expect(download).not.toHaveBeenCalled();
  });

  it("downloads only after explicit downloadModel and reports progress", async () => {
    const store = createMockSttModelStore({ downloadSteps: 2 });
    const onSelect = vi.fn();
    const { result } = renderHook(() =>
      useSttModels({
        onSelect,
        selectedModelId: "whisper-tiny.en",
        store,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.downloadModel("whisper-tiny.en");
    });

    const tiny = result.current.models.find((m) => m.id === "whisper-tiny.en");
    expect(tiny?.status).toBe("available");
    expect(result.current.progress).toBeNull();
  });

  it("selectModel persists via onSelect without downloading", async () => {
    const store = createMockSttModelStore();
    const download = vi.spyOn(store, "download");
    const onSelect = vi.fn();
    const { result } = renderHook(() =>
      useSttModels({
        onSelect,
        selectedModelId: "whisper-tiny.en",
        store,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.selectModel("whisper-base.en");
    });

    expect(onSelect).toHaveBeenCalledWith("whisper-base.en");
    expect(download).not.toHaveBeenCalled();
  });

  it("cancelDownload forwards to the model store", async () => {
    const store = createMockSttModelStore();
    const cancel = vi.spyOn(store, "cancel");
    const onSelect = vi.fn();
    const { result } = renderHook(() =>
      useSttModels({
        onSelect,
        selectedModelId: "whisper-tiny.en",
        store,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.cancelDownload("whisper-base.en");
    });

    expect(cancel).toHaveBeenCalledWith("whisper-base.en");
  });
});
