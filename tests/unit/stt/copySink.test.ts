// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ClipboardAdapter } from "../../../src/services/clipboard";
import {
  copyTranscript,
  copyTranscriptToClipboard,
} from "../../../src/services/stt/copySink";

describe("copyTranscriptToClipboard", () => {
  it("copies transcript text through ClipboardAdapter", async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    const clipboard: ClipboardAdapter = { copy };

    await copyTranscriptToClipboard("hello from STT", clipboard);

    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledWith("hello from STT");
  });

  it("propagates clipboard failures", async () => {
    const clipboard: ClipboardAdapter = {
      copy: vi.fn().mockRejectedValue(new Error("clipboard denied")),
    };

    await expect(
      copyTranscriptToClipboard("text", clipboard),
    ).rejects.toThrow("clipboard denied");
  });
});

describe("copyTranscript", () => {
  it("copies Transcript.text only (Copy sink; no insert)", async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    const clipboard: ClipboardAdapter = { copy };

    await copyTranscript({ language: "en", text: "wired copy" }, clipboard);

    expect(copy).toHaveBeenCalledWith("wired copy");
    expect(copy).toHaveBeenCalledTimes(1);
  });
});
