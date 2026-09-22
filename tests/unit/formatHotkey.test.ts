import { describe, expect, it } from "vitest";
import { toPluginHotkey } from
  "../../src/services/shortcut/formatHotkey";

describe("toPluginHotkey", () => {
  it("converts Settings display strings to plugin format", () => {
    expect(toPluginHotkey("Ctrl + Shift + Space"))
      .toBe("Control+Shift+Space");
    expect(toPluginHotkey("Ctrl + Space")).toBe("Control+Space");
    expect(toPluginHotkey("Alt + D")).toBe("Alt+D");
  });
});
