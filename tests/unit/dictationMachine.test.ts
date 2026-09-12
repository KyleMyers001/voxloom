import { describe, expect, it } from "vitest";
import { dictationReducer } from "../../src/domain/dictationMachine";

describe("dictationReducer", () => {
  it("permits the listening to processing to success path", () => {
    const listening = dictationReducer(
      { kind: "ready" },
      { runId: 4, type: "start" },
    );
    const processing = dictationReducer(
      listening,
      { runId: 4, type: "process" },
    );
    expect(dictationReducer(processing, {
      recordId: "record",
      runId: 4,
      type: "complete",
    })).toEqual({ kind: "success", recordId: "record", runId: 4 });
  });

  it("ignores illegal and stale completions", () => {
    const processing = { kind: "processing", runId: 8 } as const;
    expect(dictationReducer(processing, {
      recordId: "stale",
      runId: 7,
      type: "complete",
    })).toBe(processing);
    expect(dictationReducer({ kind: "ready" }, {
      recordId: "illegal",
      runId: 1,
      type: "fail",
    })).toEqual({ kind: "ready" });
  });

  it("cancels only active work", () => {
    expect(dictationReducer(
      { kind: "listening", runId: 3, waveform: "silent" },
      { type: "cancel" },
    )).toEqual({ kind: "cancelled", runId: 3 });
    expect(dictationReducer(
      { kind: "success", recordId: "done", runId: 3 },
      { type: "cancel" },
    )).toEqual({ kind: "success", recordId: "done", runId: 3 });
  });
});
