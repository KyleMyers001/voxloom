import { describe, expect, it } from "vitest";
import {
  createRecords,
  initialOnboarding,
  initialSettings,
} from "../../src/domain/fixtures";

describe("fixtures", () => {
  it("uses privacy-safe defaults and controlled recovery timing", () => {
    const now = 50_000;
    const failed = createRecords(now).find((record) =>
      record.status === "failed"
    );
    expect(initialSettings.audioRetention).toBe("off");
    expect(initialSettings.appearance).toBe("system");
    expect(initialOnboarding.complete).toBe(false);
    expect(failed?.recoveryExpiresAt).toBe(now + 10 * 60_000);
  });
});
