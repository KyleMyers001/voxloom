import { describe, expect, it } from "vitest";
import { appReducer, createInitialState } from "../../src/app/state";
import { canRetry } from "../../src/domain/records";

describe("appReducer", () => {
  it("adds one record and rejects a duplicate completion", () => {
    const initial = createInitialState(1_000);
    const listening = appReducer(initial, { type: "start-dictation" });
    const processing = appReducer(listening, {
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
    const cancelled = appReducer(listening, { type: "cancel-dictation" });
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
});
