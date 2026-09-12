import { describe, expect, it } from "vitest";
import { validateWord } from "../../src/domain/dictionary";

describe("validateWord", () => {
  it("trims a valid word", () => {
    expect(validateWord("  Vite  ", ["TypeScript"])).toEqual({
      ok: true,
      word: "Vite",
    });
  });

  it("rejects blanks and case-insensitive duplicates", () => {
    expect(validateWord("  ", [])).toEqual({
      error: "Enter a word.",
      ok: false,
    });
    expect(validateWord("typescript", ["TypeScript"])).toEqual({
      error: "typescript is already in your dictionary.",
      ok: false,
    });
  });
});
