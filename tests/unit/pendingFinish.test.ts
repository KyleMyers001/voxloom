import { describe, expect, it } from "vitest";
import { createPendingFinishGate } from
  "../../src/services/shortcut/pendingFinish";

describe("createPendingFinishGate", () => {
  it("finishes immediately when already listening", () => {
    const finished: number[] = [];
    const gate = createPendingFinishGate({
      finish: (runId) => finished.push(runId),
      listeningRunId: () => 7,
    });
    gate.requestFinish(true, 7);
    expect(finished).toEqual([7]);
    expect(gate.isPending()).toBe(false);
  });

  it("defers finish until listening commits (race)", () => {
    let runId: number | null = null;
    const finished: number[] = [];
    const gate = createPendingFinishGate({
      finish: (id) => finished.push(id),
      listeningRunId: () => runId,
    });
    // Release arrives before React commits listening.
    gate.requestFinish(false, null);
    expect(finished).toEqual([]);
    expect(gate.isPending()).toBe(true);
    runId = 3;
    gate.onListening();
    expect(finished).toEqual([3]);
    expect(gate.isPending()).toBe(false);
  });

  it("clear drops a pending finish (cancel / error)", () => {
    const finished: number[] = [];
    const gate = createPendingFinishGate({
      finish: (runId) => finished.push(runId),
      listeningRunId: () => 1,
    });
    gate.requestFinish(false, null);
    gate.clear();
    gate.onListening();
    expect(finished).toEqual([]);
  });

  it("resetForStart clears stale pending before a new hold", () => {
    const finished: number[] = [];
    let runId: number | null = null;
    const gate = createPendingFinishGate({
      finish: (id) => finished.push(id),
      listeningRunId: () => runId,
    });
    gate.requestFinish(false, null);
    gate.resetForStart();
    runId = 9;
    gate.onListening();
    expect(finished).toEqual([]);
  });
});
