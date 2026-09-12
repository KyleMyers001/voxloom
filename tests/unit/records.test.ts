import { describe, expect, it } from "vitest";
import {
  canRetry,
  createFailedRecord,
  createSuccessfulRecord,
} from "../../src/domain/records";

describe("record factories", () => {
  it("creates retryable failures with controlled expiry", () => {
    const record = createFailedRecord({
      id: "failed",
      now: 100,
      style: "formal",
    });
    expect(canRetry(record, 101)).toBe(true);
    expect(canRetry(record, 600_100)).toBe(false);
  });

  it("creates successful synthetic records without recovery audio", () => {
    const record = createSuccessfulRecord({
      id: "success",
      now: 100,
      style: "casual",
    });
    expect(record.status).toBe("inserted");
    expect(record.recoveryExpiresAt).toBeNull();
  });
});
