import { describe, expect, it, vi } from "vitest";
import { createClipboardAdapter } from "../../src/services/clipboard";

describe("createClipboardAdapter", () => {
  it("writes only when copy is explicitly called", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const clipboard = createClipboardAdapter();
    expect(writeText).not.toHaveBeenCalled();
    await clipboard.copy("synthetic text");
    expect(writeText).toHaveBeenCalledWith("synthetic text");
  });

  it("surfaces injected failure", async () => {
    await expect(createClipboardAdapter(() => true).copy("text"))
      .rejects.toThrow("Simulated clipboard failure");
  });
});
