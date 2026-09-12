import { describe, expect, it, vi } from "vitest";
import type { Scheduler, ShortcutGesture } from
  "../../src/services/contracts";
import { createShortcutController } from
  "../../src/services/shortcutController";

function shortcutEvent(type: "keydown" | "keyup", repeat = false) {
  return new KeyboardEvent(type, {
    bubbles: true,
    code: "Space",
    ctrlKey: true,
    key: " ",
    repeat,
    shiftKey: true,
  });
}

describe("createShortcutController", () => {
  it("recognizes hold/release and suppresses repeat", () => {
    vi.useFakeTimers();
    let now = 0;
    const gestures: ShortcutGesture[] = [];
    const controller = createShortcutController({
      clock: () => now,
      onGesture: (gesture) => gestures.push(gesture),
      shortcut: "Ctrl + Shift + Space",
      target: document,
    });
    document.dispatchEvent(shortcutEvent("keydown"));
    document.dispatchEvent(shortcutEvent("keydown", true));
    now = 320;
    vi.advanceTimersByTime(320);
    document.dispatchEvent(shortcutEvent("keyup"));
    expect(gestures).toEqual(["hold-start", "hold-finish"]);
    controller.dispose();
    vi.useRealTimers();
  });

  it("latches a rapid double-tap and finishes on next activation", () => {
    let now = 0;
    const callbacks = new Map<number, () => void>();
    let timer = 0;
    const scheduler: Scheduler = {
      clear: (id) => callbacks.delete(id),
      set: (callback) => {
        timer += 1;
        callbacks.set(timer, callback);
        return timer;
      },
    };
    const gestures: ShortcutGesture[] = [];
    const controller = createShortcutController({
      clock: () => now,
      onGesture: (gesture) => gestures.push(gesture),
      scheduler,
      shortcut: "Ctrl + Shift + Space",
      target: document,
    });
    document.dispatchEvent(shortcutEvent("keydown"));
    document.dispatchEvent(shortcutEvent("keyup"));
    now = 100;
    document.dispatchEvent(shortcutEvent("keydown"));
    document.dispatchEvent(shortcutEvent("keyup"));
    now = 180;
    document.dispatchEvent(shortcutEvent("keydown"));
    document.dispatchEvent(shortcutEvent("keyup"));
    expect(gestures).toEqual(["latch-start", "latch-finish"]);
    controller.dispose();
  });
});
