import { describe, expect, it, vi } from "vitest";
import type { ClipboardAdapter } from "../../../src/services/clipboard";
import { copyTranscriptToClipboard } from "../../../src/services/stt/copySink";

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
