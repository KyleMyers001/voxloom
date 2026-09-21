// @vitest-environment node
import { describe, expect, it } from "vitest";
import { audioHandleFromCapture } from "../../../src/services/stt/fromCapture";

describe("audioHandleFromCapture", () => {
  it("maps snake_case capture IPC metadata to AudioBufferHandle", () => {
    expect(
      audioHandleFromCapture({
        duration_ms: 1500,
        id: "pcm-9",
        sample_rate_hz: 16_000,
      }),
    ).toEqual({
      durationMs: 1500,
      id: "pcm-9",
      sampleRateHz: 16_000,
    });
  });
});
