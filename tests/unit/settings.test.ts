import { describe, expect, it } from "vitest";
import { parseChoice, writingStyles } from "../../src/domain/settings";

describe("parseChoice", () => {
  it("accepts exact settings and rejects invalid DOM values", () => {
    expect(parseChoice("casual", writingStyles)).toBe("casual");
    expect(() => parseChoice("verbose", writingStyles))
      .toThrow("Invalid setting: verbose");
  });
});
