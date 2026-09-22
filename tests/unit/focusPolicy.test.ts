import { describe, expect, it } from "vitest";
import { shouldResetGesturesOnDocumentHidden } from
  "../../src/services/shortcut/focusPolicy";

describe("shouldResetGesturesOnDocumentHidden", () => {
  it("resets document-focused mock on hide (missed keyup risk)", () => {
    expect(shouldResetGesturesOnDocumentHidden("document-focused")).toBe(true);
  });

  it("does not reset native-global on hide (other-app focus ≠ cancel)", () => {
    expect(shouldResetGesturesOnDocumentHidden("native-global")).toBe(false);
  });
});
