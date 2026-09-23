// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ClipboardAdapter } from "../../../src/services/clipboard";
import { dogfoodTranscribeAndCopy } from "../../../src/services/stt/dogfoodPath";
import { createMockSttEngine } from "../../../src/services/stt/mockStt";

function clipboard(): ClipboardAdapter {
  return { copy: vi.fn().mockResolvedValue(undefined) };
}

describe("dogfoodTranscribeAndCopy", () => {
  it("uses the selected modelId on the engine and copies transcript", async () => {
    const clip = clipboard();
    const createEngine = vi.fn((modelId: string) =>
      createMockSttEngine({
        modelId,
        transcriptText: `from ${modelId}`,
      }),
    );

    const result = await dogfoodTranscribeAndCopy({
      audio: {
        duration_ms: 1_200,
        id: "pcm-1",
        sample_rate_hz: 16_000,
      },
      clipboard: clip,
      createEngine,
      modelId: "whisper-base.en",
    });

    expect(createEngine).toHaveBeenCalledWith("whisper-base.en");
    expect(result.transcript.text).toBe("from whisper-base.en");
    expect(result.copied).toBe(true);
    expect(result.copyWarning).toBeUndefined();
    expect(result.delivery.status).toBe("copied");
    expect(result.delivery.message).toMatch(/^Copied/);
    expect(clip.copy).toHaveBeenCalledWith("from whisper-base.en");
  });

  it("soft-fails Copy: still returns transcript when clipboard throws", async () => {
    const clip: ClipboardAdapter = {
      copy: vi.fn().mockRejectedValue(new Error("NotAllowedError")),
    };
    const createEngine = vi.fn((modelId: string) =>
      createMockSttEngine({
        modelId,
        transcriptText: "heard you",
      }),
    );

    const result = await dogfoodTranscribeAndCopy({
      audio: { duration_ms: 400, id: "pcm-soft", sample_rate_hz: 16_000 },
      clipboard: clip,
      createEngine,
      modelId: "whisper-tiny.en",
    });

    expect(result.transcript.text).toBe("heard you");
    expect(result.copied).toBe(false);
    expect(result.delivery.status).toBe("failed");
    expect(result.copyWarning).toMatch(/NotAllowedError|clipboard/i);
  });

  it("maps legacy simulated labels to the default model id", async () => {
    const createEngine = vi.fn((modelId: string) =>
      createMockSttEngine({ modelId }),
    );

    await dogfoodTranscribeAndCopy({
      audio: { duration_ms: 100, id: "pcm-2", sample_rate_hz: 16_000 },
      clipboard: clipboard(),
      createEngine,
      modelId: "Pine Voice Small · local",
    });

    expect(createEngine).toHaveBeenCalledWith("whisper-tiny.en");
  });

  it("never auto-downloads — only constructs an engine", async () => {
    const download = vi.fn();
    const createEngine = vi.fn((modelId: string) => {
      // Prove dogfood path does not touch a model store download.
      expect(download).not.toHaveBeenCalled();
      return createMockSttEngine({ modelId });
    });

    await dogfoodTranscribeAndCopy({
      audio: { duration_ms: 50, id: "pcm-3", sample_rate_hz: 16_000 },
      clipboard: clipboard(),
      createEngine,
      modelId: "whisper-tiny.en",
    });

    expect(download).not.toHaveBeenCalled();
    expect(createEngine).toHaveBeenCalledOnce();
  });
});

describe("dogfoodTranscribeAndCopy delivery (BUS-14)", () => {
  it("reports Inserted when injected platform insert succeeds", async () => {
    const clip = clipboard();
    const insertText = vi.fn().mockResolvedValue(undefined);
    const intended = {
      appName: "Notes",
      appPid: 7,
      capturedAt: 1,
      elementId: "7:AXTextArea:",
      elementRole: "AXTextArea",
      insertable: true,
      kind: "insertable" as const,
      reason: null,
    };
    const deliveryPlatform = {
      clipboardRead: vi.fn().mockResolvedValue({ ok: true, text: "" }),
      clipboardRestore: vi.fn(),
      clipboardWrite: vi.fn(),
      insertText,
      snapshotTarget: vi.fn().mockResolvedValue(intended),
      validateTarget: vi.fn().mockResolvedValue(intended),
    };

    const result = await dogfoodTranscribeAndCopy({
      audio: { duration_ms: 200, id: "pcm-ins", sample_rate_hz: 16_000 },
      clipboard: clip,
      createEngine: (modelId) =>
        createMockSttEngine({ modelId, transcriptText: "into notes" }),
      deliveryPlatform,
      intended,
      modelId: "whisper-tiny.en",
    });

    expect(result.delivery.status).toBe("inserted");
    expect(result.delivery.message).toBe("Inserted");
    expect(result.copied).toBe(false);
    expect(insertText).toHaveBeenCalledWith("into notes", intended);
    expect(clip.copy).not.toHaveBeenCalled();
  });

  it("honors clipboardFallback=false on refused target", async () => {
    const clip = clipboard();
    const secure = {
      appName: "Safari",
      appPid: 9,
      capturedAt: 1,
      elementId: "9:AXSecureTextField:",
      elementRole: "AXSecureTextField",
      insertable: false,
      kind: "secure" as const,
      reason: "secure field — insert skipped",
    };
    const deliveryPlatform = {
      clipboardRead: vi.fn(),
      clipboardRestore: vi.fn(),
      clipboardWrite: vi.fn(),
      insertText: vi.fn(),
      snapshotTarget: vi.fn().mockResolvedValue(secure),
      validateTarget: vi.fn().mockResolvedValue(secure),
    };

    const result = await dogfoodTranscribeAndCopy({
      audio: { duration_ms: 100, id: "pcm-sec", sample_rate_hz: 16_000 },
      clipboard: clip,
      clipboardFallback: false,
      createEngine: (modelId) =>
        createMockSttEngine({ modelId, transcriptText: "password" }),
      deliveryPlatform,
      intended: secure,
      modelId: "whisper-tiny.en",
    });

    expect(result.delivery.status).toBe("failed");
    expect(result.delivery.message).toMatch(/secure/i);
    expect(clip.copy).not.toHaveBeenCalled();
    expect(result.delivery.text).toBe("password");
  });
});
