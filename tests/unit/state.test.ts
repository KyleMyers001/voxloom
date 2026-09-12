import { describe, expect, it } from "vitest";
import { appReducer, createInitialState } from "../../src/app/state";
import { canRetry } from "../../src/domain/records";

describe("appReducer", () => {
  it("adds one record and rejects a duplicate completion", () => {
    const initial = createInitialState(1_000);
    const listening = appReducer(initial, { type: "start-dictation" });
    const processing = appReducer(listening, {
      completion: "held",
      runId: 1,
      type: "process-dictation",
    });
    const complete = appReducer(processing, {
      now: 2_000,
      runId: 1,
      type: "complete-dictation",
    });
    const duplicate = appReducer(complete, {
      now: 3_000,
      runId: 1,
      type: "complete-dictation",
    });
    expect(complete.records).toHaveLength(initial.records.length + 1);
    expect(duplicate).toBe(complete);
  });

  it("does not create success after cancellation", () => {
    const initial = createInitialState(1_000);
    const listening = appReducer(initial, { type: "start-dictation" });
    const cancelled = appReducer(listening, {
      runId: 1,
      type: "cancel-dictation",
    });
    const completion = appReducer(cancelled, {
      now: 2_000,
      runId: 1,
      type: "complete-dictation",
    });
    expect(completion).toBe(cancelled);
  });

  it("uses the supplied time to guard retry expiry", () => {
    const state = createInitialState(10_000);
    const failed = state.records.find((record) => record.status === "failed");
    expect(failed).toBeDefined();
    if (!failed?.recoveryExpiresAt) return;
    expect(canRetry(failed, failed.recoveryExpiresAt - 1)).toBe(true);
    expect(canRetry(failed, failed.recoveryExpiresAt)).toBe(false);
    expect(appReducer(state, {
      id: failed.id,
      now: failed.recoveryExpiresAt,
      type: "retry",
    })).toBe(state);
  });

  it("resolves a retry source without duplicating history", () => {
    const initial = createInitialState(10_000);
    const failed = initial.records.find((record) =>
      record.status === "failed"
    );
    if (!failed) throw new Error("fixture failure missing");
    const retrying = appReducer(initial, {
      id: failed.id,
      now: 10_001,
      type: "retry",
    });
    const complete = appReducer(retrying, {
      now: 10_100,
      runId: 1,
      type: "complete-dictation",
    });
    expect(complete.records).toHaveLength(initial.records.length);
    expect(complete.records.find(({ id }) => id === failed.id)?.status)
      .toBe("inserted");
    expect(appReducer(complete, {
      now: 10_200,
      runId: 1,
      type: "complete-dictation",
    })).toBe(complete);
  });

  it("guards retry terminals and permits retry after cancel", () => {
    const initial = createInitialState(10_000);
    const failed = initial.records.find((record) =>
      record.status === "failed"
    );
    if (!failed) throw new Error("fixture failure missing");
    const retrying = appReducer(initial, {
      id: failed.id,
      now: 10_001,
      type: "retry",
    });
    const staleActions = [
      { now: 10_002, runId: 99, type: "fail-dictation" },
      { now: 10_002, runId: 99, type: "complete-dictation" },
      { runId: 99, type: "cancel-dictation" },
    ] as const;
    for (const action of staleActions) {
      expect(appReducer(retrying, action)).toBe(retrying);
    }
    const cancelled = appReducer(retrying, {
      runId: 1,
      type: "cancel-dictation",
    });
    const repeated = appReducer(cancelled, {
      id: failed.id,
      now: 10_003,
      type: "retry",
    });
    expect(repeated.dictation).toMatchObject({
      retrySourceId: failed.id,
      runId: 2,
    });
  });
});
