import { describe, expect, it } from "vitest";
import {
  canRetry,
  createDogfoodRecord,
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

describe("createDogfoodRecord", () => {
  it("uses copied status when clipboard write succeeded", () => {
    const record = createDogfoodRecord({
      copied: true,
      durationMs: 1_500,
      id: "dogfood-pcm-1",
      now: 1_000,
      style: "casual",
      text: "  hello world  ",
    });
    expect(record).toEqual({
      createdAt: 1_000,
      durationSeconds: 2,
      id: "dogfood-pcm-1",
      model: null,
      recoveryExpiresAt: null,
      status: "copied",
      style: "casual",
      text: "hello world",
    });
  });

  it("uses failed status when Copy soft-failed but text exists", () => {
    const record = createDogfoodRecord({
      copied: false,
      durationMs: 900,
      id: "dogfood-pcm-2",
      now: 5_000,
      style: "formal",
      text: "still here",
    });
    expect(record?.status).toBe("failed");
    expect(record?.text).toBe("still here");
    expect(record?.durationSeconds).toBe(1);
    expect(record?.recoveryExpiresAt).toBe(5_000 + 10 * 60_000);
    expect(canRetry(record!, 5_001)).toBe(true);
  });

  it("returns null for blank or whitespace-only transcripts", () => {
    expect(createDogfoodRecord({
      copied: true,
      durationMs: 400,
      id: "dogfood-blank",
      now: 1,
      style: "formal",
      text: "",
    })).toBeNull();
    expect(createDogfoodRecord({
      copied: true,
      durationMs: 400,
      id: "dogfood-ws",
      now: 1,
      style: "formal",
      text: "   \n\t  ",
    })).toBeNull();
  });

  it("stamps model when provided", () => {
    const record = createDogfoodRecord({
      copied: true,
      durationMs: 1_000,
      id: "dogfood-model",
      model: "whisper-tiny.en",
      now: 10,
      style: "formal",
      text: "hi",
    });
    expect(record?.model).toBe("whisper-tiny.en");
  });
});
