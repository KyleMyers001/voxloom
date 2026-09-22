import { describe, expect, it } from "vitest";
import type { Scheduler, ShortcutGesture } from
  "../../src/services/contracts";
import { createGestureMachine } from
  "../../src/services/shortcut/gestureMachine";

function makeScheduler() {
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
  const flush = (id: number) => {
    const cb = callbacks.get(id);
    if (cb) {
      callbacks.delete(id);
      cb();
    }
  };
  return { flush, scheduler };
}

describe("createGestureMachine", () => {
  it("emits hold-start/finish after holdMs", () => {
    const gestures: ShortcutGesture[] = [];
    const { flush, scheduler } = makeScheduler();
    const machine = createGestureMachine({
      clock: () => 0,
      holdMs: 320,
      onGesture: (g) => gestures.push(g),
      scheduler,
    });
    machine.handle("pressed");
    flush(1);
    machine.handle("released");
    expect(gestures).toEqual(["hold-start", "hold-finish"]);
    machine.dispose();
  });

  it("latches on double-tap within window and finishes on next press", () => {
    let now = 0;
    const gestures: ShortcutGesture[] = [];
    const { scheduler } = makeScheduler();
    const machine = createGestureMachine({
      clock: () => now,
      doubleTapMs: 260,
      onGesture: (g) => gestures.push(g),
      scheduler,
    });
    machine.handle("pressed");
    machine.handle("released");
    now = 100;
    machine.handle("pressed");
    machine.handle("released");
    now = 180;
    machine.handle("pressed");
    machine.handle("released");
    expect(gestures).toEqual(["latch-start", "latch-finish"]);
    machine.dispose();
  });

  it("resetPartial clears mid-hold without emitting", () => {
    const gestures: ShortcutGesture[] = [];
    const { flush, scheduler } = makeScheduler();
    const machine = createGestureMachine({
      clock: () => 0,
      onGesture: (g) => gestures.push(g),
      scheduler,
    });
    machine.handle("pressed");
    machine.resetPartial();
    flush(1);
    machine.handle("released");
    expect(gestures).toEqual([]);
    machine.dispose();
  });

  it("setContext null ignores edges and clears latched state", () => {
    let now = 0;
    const gestures: ShortcutGesture[] = [];
    const { scheduler } = makeScheduler();
    const machine = createGestureMachine({
      clock: () => now,
      onGesture: (g) => gestures.push(g),
      scheduler,
    });
    machine.handle("pressed");
    machine.handle("released");
    now = 50;
    machine.handle("pressed");
    machine.handle("released");
    expect(gestures).toEqual(["latch-start"]);
    machine.setContext(null);
    gestures.length = 0;
    now = 100;
    machine.handle("pressed");
    machine.handle("released");
    expect(gestures).toEqual([]);
    machine.setContext("product");
    now = 200;
    machine.handle("pressed");
    machine.handle("released");
    now = 280;
    machine.handle("pressed");
    machine.handle("released");
    now = 360;
    machine.handle("pressed");
    machine.handle("released");
    expect(gestures).toEqual(["latch-start", "latch-finish"]);
    machine.dispose();
  });

  it("finishes hold on synthetic Released after Pressed (Mac watch path)", () => {
    const gestures: ShortcutGesture[] = [];
    const { flush, scheduler } = makeScheduler();
    const machine = createGestureMachine({
      clock: () => 0,
      holdMs: 320,
      onGesture: (g) => gestures.push(g),
      scheduler,
    });
    machine.handle("pressed");
    flush(1);
    expect(gestures).toEqual(["hold-start"]);
    // Synthetic Released from hold-release watch (HotKey Released missing).
    machine.handle("released");
    expect(gestures).toEqual(["hold-start", "hold-finish"]);
    // Duplicate Released is a no-op.
    machine.handle("released");
    expect(gestures).toEqual(["hold-start", "hold-finish"]);
    machine.dispose();
  });
});
