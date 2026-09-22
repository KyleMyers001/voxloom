import { describe, expect, it } from "vitest";
import {
  isOverlayVisible,
  overlayWaveformFromDictation,
} from "../../src/services/shortcut/overlayVisibility";
import { overlaySyncPlan } from
  "../../src/services/shortcut/overlayBridge";

describe("overlay visibility", () => {
  it("is visible only for listening and processing", () => {
    expect(isOverlayVisible("ready")).toBe(false);
    expect(isOverlayVisible("listening")).toBe(true);
    expect(isOverlayVisible("processing")).toBe(true);
    expect(isOverlayVisible("success")).toBe(false);
    expect(isOverlayVisible("cancelled")).toBe(false);
    expect(isOverlayVisible("error")).toBe(false);
  });

  it("maps dictation waveform for the overlay bridge", () => {
    expect(overlayWaveformFromDictation({
      kind: "listening",
      runId: 1,
      waveform: "silent",
    })).toBe("silent");
    expect(overlayWaveformFromDictation({
      kind: "listening",
      runId: 1,
      waveform: "speaking",
    })).toBe("speaking");
    expect(overlayWaveformFromDictation({
      completion: "held",
      kind: "processing",
      runId: 1,
    })).toBe("processing");
    expect(overlayWaveformFromDictation({ kind: "ready" })).toBeNull();
  });

  it("overlaySyncPlan hides after cancel/error", () => {
    expect(overlaySyncPlan({
      kind: "listening",
      runId: 2,
      waveform: "speaking",
    })).toEqual({ visible: true, waveform: "speaking" });
    expect(overlaySyncPlan({ kind: "cancelled", runId: 2 }))
      .toEqual({ visible: false, waveform: null });
    expect(overlaySyncPlan({
      kind: "error",
      recordId: "x",
      runId: 2,
    })).toEqual({ visible: false, waveform: null });
  });
});
