import { describe, expect, it, vi } from "vitest";
import { createMockDictationService } from
  "../../src/services/mock/dictationService";

describe("createMockDictationService", () => {
  it("maps lifecycle calls to typed boundary actions", () => {
    const dispatch = vi.fn();
    const service = createMockDictationService({
      dispatch,
      now: () => 42,
    });
    service.start();
    service.finish(3);
    service.cancel(3);
    service.retry("failed-1");
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "start-dictation" },
      {
        completion: "automatic",
        runId: 3,
        type: "process-dictation",
      },
      { runId: 3, type: "cancel-dictation" },
      { id: "failed-1", now: 42, type: "retry" },
    ]);
  });
});
