// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createMockSttEngine,
  createMockSttModelStore,
  MOCK_TRANSCRIPT_TEXT,
} from "../../../src/services/stt/mockStt";
import { DEFAULT_STT_MODEL_ID, SttError } from "../../../src/services/stt/types";

describe("createMockSttModelStore", () => {
  it("lists models as missing without downloading on construct", async () => {
    const store = createMockSttModelStore();
    const models = await store.list();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.status === "missing")).toBe(true);
  });

  it("download only runs when explicitly called and reports progress", async () => {
    const store = createMockSttModelStore({ downloadSteps: 3 });
    const onProgress = vi.fn();
    const modelId = "whisper-tiny.en";

    expect(onProgress).not.toHaveBeenCalled();
    await store.download(modelId, onProgress);

    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress.mock.calls.map(([p]) => p.ratio)).toEqual([
      1 / 3,
      2 / 3,
      1,
    ]);
    const info = await store.status(modelId);
    expect(info?.status).toBe("available");
  });

  it("cancel during download marks model missing and throws cancelled", async () => {
    const store = createMockSttModelStore({ downloadSteps: 5 });
    const modelId = "whisper-base.en";
    let sawProgress = false;

    const downloadPromise = store.download(modelId, async () => {
      if (!sawProgress) {
        sawProgress = true;
        await store.cancel(modelId);
      }
    });

    await expect(downloadPromise).rejects.toMatchObject({
      code: "cancelled",
      name: "SttError",
    });
    expect((await store.status(modelId))?.status).toBe("missing");
  });

  it("rejects unknown model download", async () => {
    const store = createMockSttModelStore();
    await expect(store.download("no-such-model")).rejects.toBeInstanceOf(
      SttError,
    );
  });
});

describe("createMockSttEngine modelId requirement", () => {
  it("exposes explicit modelId (defaults to English-first tiny)", async () => {
    const engine = createMockSttEngine();
    expect(engine.modelId).toBe(DEFAULT_STT_MODEL_ID);
  });

  it("honors an explicit modelId option", () => {
    const engine = createMockSttEngine({ modelId: "whisper-base.en" });
    expect(engine.modelId).toBe("whisper-base.en");
  });

  it("rejects empty modelId", () => {
    expect(() => createMockSttEngine({ modelId: "  " })).toThrow(SttError);
    try {
      createMockSttEngine({ modelId: "" });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "model-missing" });
    }
  });

  it("returns deterministic transcript text", async () => {
    const engine = createMockSttEngine();
    const result = await engine.transcribe({
      durationMs: 1_000,
      id: "buf-1",
      sampleRateHz: 16_000,
    });
    expect(result).toEqual({
      language: "en",
      text: MOCK_TRANSCRIPT_TEXT,
    });
  });

  it("honors custom transcript text", async () => {
    const engine = createMockSttEngine({ transcriptText: "custom line" });
    const result = await engine.transcribe({
      durationMs: 500,
      id: "buf-2",
      sampleRateHz: 16_000,
    });
    expect(result.text).toBe("custom line");
  });

  it("rejects empty audio handle id", async () => {
    const engine = createMockSttEngine();
    await expect(
      engine.transcribe({
        durationMs: 0,
        id: "",
        sampleRateHz: 16_000,
      }),
    ).rejects.toMatchObject({ code: "unsupported-audio" });
  });
});
