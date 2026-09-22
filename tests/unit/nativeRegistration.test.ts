import { describe, expect, it, vi } from "vitest";
import type { Scheduler } from "../../src/services/contracts";
import {
  createNativeShortcutController,
  type NativeShortcutApi,
} from "../../src/services/shortcut/nativeRegistration";
import type { HoldReleaseApi } from "../../src/services/shortcut/holdReleaseBridge";

function makeScheduler(): Scheduler {
  return {
    clear: () => undefined,
    set: () => 1,
  };
}

function makeHoldRelease(): HoldReleaseApi {
  return {
    arm: async () => false,
    disarm: async () => undefined,
    isAvailable: () => false,
    listen: async () => () => undefined,
  };
}

function makeApi(options?: {
  /** Simulate OS rejecting a second register of an already-bound hotkey. */
  rejectDuplicate?: boolean;
}): {
  api: NativeShortcutApi;
  registerCalls: string[];
  unregisterCalls: string[];
} {
  const registerCalls: string[] = [];
  const unregisterCalls: string[] = [];
  const bound = new Set<string>();
  const rejectDuplicate = options?.rejectDuplicate ?? true;
  const api: NativeShortcutApi = {
    isAvailable: () => true,
    async register(hotkey) {
      registerCalls.push(hotkey);
      if (rejectDuplicate && bound.has(hotkey)) {
        throw new Error(`RegisterEventHotKey failed for ${hotkey}`);
      }
      bound.add(hotkey);
    },
    async unregister(hotkey) {
      unregisterCalls.push(hotkey);
      bound.delete(hotkey);
    },
    async unregisterAll() {
      bound.clear();
    },
  };
  return { api, registerCalls, unregisterCalls };
}

describe("createNativeShortcutController setShortcut", () => {
  it("concurrent/duplicate setShortcut same combo does not fail/toast/unbind", async () => {
    const { api, registerCalls, unregisterCalls } = makeApi();
    const onRegisterFailure = vi.fn();
    const controller = createNativeShortcutController({
      api,
      clock: () => 0,
      holdRelease: makeHoldRelease(),
      onGesture: () => undefined,
      onRegisterFailure,
      scheduler: makeScheduler(),
    });

    const combo = "Ctrl + Shift + F";
    // Boot race: mount effect + Settings effect fire in parallel.
    const [a, b] = await Promise.all([
      controller.setShortcut(combo),
      controller.setShortcut(combo),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.active).toBe("Control+Shift+F");
      expect(b.active).toBe("Control+Shift+F");
    }
    expect(controller.activeHotkey()).toBe("Control+Shift+F");
    expect(onRegisterFailure).not.toHaveBeenCalled();
    // One real OS register; duplicate is a same-combo no-op (no unregister).
    expect(registerCalls).toEqual(["Control+Shift+F"]);
    expect(unregisterCalls).toEqual([]);

    await controller.dispose();
  });

  it("still reports conflict when a different combo fails to bind", async () => {
    const registerCalls: string[] = [];
    const api: NativeShortcutApi = {
      isAvailable: () => true,
      async register(hotkey) {
        registerCalls.push(hotkey);
        if (hotkey === "Control+Space") {
          throw new Error("already registered");
        }
      },
      async unregister() {},
      async unregisterAll() {},
    };
    const onRegisterFailure = vi.fn();
    const controller = createNativeShortcutController({
      api,
      clock: () => 0,
      holdRelease: makeHoldRelease(),
      onGesture: () => undefined,
      onRegisterFailure,
      scheduler: makeScheduler(),
    });

    const first = await controller.setShortcut("Ctrl + Shift + Space");
    expect(first.ok).toBe(true);

    const second = await controller.setShortcut("Ctrl + Space");
    expect(second.ok).toBe(false);
    expect(controller.activeHotkey()).toBe("Control+Shift+Space");
    expect(onRegisterFailure).toHaveBeenCalledTimes(1);
    expect(onRegisterFailure.mock.calls[0]![0]).toContain("Kept prior shortcut");

    await controller.dispose();
  });
});

describe("createNativeShortcutController focus-safe hold", () => {
  function makeTrackingScheduler() {
    const callbacks = new Map<number, () => void>();
    let timer = 0;
    const scheduler: Scheduler = {
      clear: (id) => {
        callbacks.delete(id);
      },
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

  it("ignores OS Released while Mac hold monitor is active; watch finishes", async () => {
    let onEdge: ((edge: "pressed" | "released") => void) | null = null;
    let onHoldRelease: (() => void) | null = null;
    const api: NativeShortcutApi = {
      isAvailable: () => true,
      async register(_hotkey, edge) {
        onEdge = edge;
      },
      async unregister() {},
      async unregisterAll() {},
    };
    const holdRelease: HoldReleaseApi = {
      isAvailable: () => true,
      arm: async () => true,
      disarm: async () => undefined,
      listen: async (cb) => {
        onHoldRelease = cb;
        return () => undefined;
      },
    };
    const gestures: string[] = [];
    const { flush, scheduler } = makeTrackingScheduler();
    const controller = createNativeShortcutController({
      api,
      clock: () => 0,
      holdMs: 10,
      holdRelease,
      onGesture: (g) => gestures.push(g),
      scheduler,
    });

    await controller.setShortcut("Ctrl + Shift + F");
    // Allow listen() microtask to attach.
    await Promise.resolve();
    expect(onEdge).not.toBeNull();

    onEdge!("pressed");
    flush(1); // hold-start → arms monitor
    await Promise.resolve();
    await Promise.resolve();
    expect(gestures).toEqual(["hold-start"]);

    // Spurious Carbon Released (focus loss) must not finish while monitor owns it.
    onEdge!("released");
    expect(gestures).toEqual(["hold-start"]);

    // Real chord break via hold-release watch.
    onHoldRelease!();
    expect(gestures).toEqual(["hold-start", "hold-finish"]);

    await controller.dispose();
  });

  it("still finishes via OS Released when hold monitor is not active", async () => {
    let onEdge: ((edge: "pressed" | "released") => void) | null = null;
    const api: NativeShortcutApi = {
      isAvailable: () => true,
      async register(_hotkey, edge) {
        onEdge = edge;
      },
      async unregister() {},
      async unregisterAll() {},
    };
    const holdRelease: HoldReleaseApi = {
      isAvailable: () => false,
      arm: async () => false,
      disarm: async () => undefined,
      listen: async () => () => undefined,
    };
    const gestures: string[] = [];
    const { flush, scheduler } = makeTrackingScheduler();
    const controller = createNativeShortcutController({
      api,
      clock: () => 0,
      holdMs: 10,
      holdRelease,
      onGesture: (g) => gestures.push(g),
      scheduler,
    });

    await controller.setShortcut("Ctrl + Shift + F");
    onEdge!("pressed");
    flush(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(gestures).toEqual(["hold-start"]);

    onEdge!("released");
    expect(gestures).toEqual(["hold-start", "hold-finish"]);

    await controller.dispose();
  });

  it("setContext with the same value does not cancel an active hold", async () => {
    let onEdge: ((edge: "pressed" | "released") => void) | null = null;
    let disarmCalls = 0;
    const api: NativeShortcutApi = {
      isAvailable: () => true,
      async register(_hotkey, edge) {
        onEdge = edge;
      },
      async unregister() {},
      async unregisterAll() {},
    };
    const holdRelease: HoldReleaseApi = {
      isAvailable: () => true,
      arm: async () => true,
      disarm: async () => {
        disarmCalls += 1;
      },
      listen: async () => () => undefined,
    };
    const gestures: string[] = [];
    const { flush, scheduler } = makeTrackingScheduler();
    const controller = createNativeShortcutController({
      api,
      clock: () => 0,
      holdMs: 10,
      holdRelease,
      onGesture: (g) => gestures.push(g),
      scheduler,
    });

    await controller.setShortcut("Ctrl + Shift + F");
    onEdge!("pressed");
    flush(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(gestures).toEqual(["hold-start"]);
    const disarmsAfterArm = disarmCalls;

    // Re-assert product context (modal subscribe / boot) must be a no-op.
    controller.setContext("product");
    expect(disarmCalls).toBe(disarmsAfterArm);
    expect(gestures).toEqual(["hold-start"]);

    // Context null (modal) still resets.
    controller.setContext(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(disarmCalls).toBeGreaterThan(disarmsAfterArm);
    gestures.length = 0;
    onEdge!("released");
    expect(gestures).toEqual([]);

    await controller.dispose();
  });

  it("sync monitoring flag ignores OS Released before arm() resolves", async () => {
    let onEdge: ((edge: "pressed" | "released") => void) | null = null;
    let resolveArm: ((v: boolean) => void) | null = null;
    const api: NativeShortcutApi = {
      isAvailable: () => true,
      async register(_hotkey, edge) {
        onEdge = edge;
      },
      async unregister() {},
      async unregisterAll() {},
    };
    const holdRelease: HoldReleaseApi = {
      isAvailable: () => true,
      arm: () =>
        new Promise<boolean>((resolve) => {
          resolveArm = resolve;
        }),
      disarm: async () => undefined,
      listen: async () => () => undefined,
    };
    const gestures: string[] = [];
    const { flush, scheduler } = makeTrackingScheduler();
    const controller = createNativeShortcutController({
      api,
      clock: () => 0,
      holdMs: 10,
      holdRelease,
      onGesture: (g) => gestures.push(g),
      scheduler,
    });

    await controller.setShortcut("Ctrl + Shift + F");
    onEdge!("pressed");
    flush(1); // hold-start → arms with sync monitoring=true
    expect(gestures).toEqual(["hold-start"]);
    // Hold-watch arm is queued; flush microtasks so arm() starts.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolveArm).not.toBeNull();

    // Carbon Released-after-arm before invoke resolves must not finish.
    onEdge!("released");
    expect(gestures).toEqual(["hold-start"]);

    resolveArm!(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(gestures).toEqual(["hold-start"]);

    await controller.dispose();
  });

  it("flushes suppressed OS Released when arm declines monitoring", async () => {
    let onEdge: ((edge: "pressed" | "released") => void) | null = null;
    let resolveArm: ((v: boolean) => void) | null = null;
    const api: NativeShortcutApi = {
      isAvailable: () => true,
      async register(_hotkey, edge) {
        onEdge = edge;
      },
      async unregister() {},
      async unregisterAll() {},
    };
    const holdRelease: HoldReleaseApi = {
      isAvailable: () => true,
      arm: () =>
        new Promise<boolean>((resolve) => {
          resolveArm = resolve;
        }),
      disarm: async () => undefined,
      listen: async () => () => undefined,
    };
    const gestures: string[] = [];
    const { flush, scheduler } = makeTrackingScheduler();
    const controller = createNativeShortcutController({
      api,
      clock: () => 0,
      holdMs: 10,
      holdRelease,
      onGesture: (g) => gestures.push(g),
      scheduler,
    });

    await controller.setShortcut("Ctrl + Shift + F");
    onEdge!("pressed");
    flush(1);
    // Optimistic monitoring is sync; arm() itself is queued.
    await Promise.resolve();
    await Promise.resolve();
    onEdge!("released"); // suppressed while optimistic monitoring
    expect(gestures).toEqual(["hold-start"]);

    resolveArm!(false); // non-Mac / declined → OS Released authoritative
    await Promise.resolve();
    await Promise.resolve();
    expect(gestures).toEqual(["hold-start", "hold-finish"]);

    await controller.dispose();
  });


  it("two sequential holds both finish; late disarm cannot kill next watch", async () => {
    let onEdge: ((edge: "pressed" | "released") => void) | null = null;
    let onHoldRelease: (() => void) | null = null;
    let armCount = 0;
    let pendingDisarm: Promise<void> | null = null;
    let resolveHold1Disarm: (() => void) | null = null;
    let slowDisarmArmed = false;
    const api: NativeShortcutApi = {
      isAvailable: () => true,
      async register(_hotkey, edge) {
        onEdge = edge;
      },
      async unregister() {},
      async unregisterAll() {},
    };
    const holdRelease: HoldReleaseApi = {
      isAvailable: () => true,
      arm: async () => {
        armCount += 1;
        return true;
      },
      disarm: async () => {
        if (!slowDisarmArmed) return;
        slowDisarmArmed = false;
        pendingDisarm = new Promise<void>((resolve) => {
          resolveHold1Disarm = resolve;
        });
        await pendingDisarm;
      },
      listen: async (cb) => {
        onHoldRelease = cb;
        return () => undefined;
      },
    };
    const gestures: string[] = [];
    const { flush, scheduler } = makeTrackingScheduler();
    const controller = createNativeShortcutController({
      api,
      clock: () => 0,
      holdMs: 10,
      holdRelease,
      onGesture: (g) => gestures.push(g),
      scheduler,
    });

    const drain = async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    };

    await controller.setShortcut("Ctrl + Shift + F");
    await drain();

    // Hold 1
    onEdge!("pressed");
    flush(1);
    await drain();
    expect(gestures).toEqual(["hold-start"]);
    expect(armCount).toBe(1);

    // Next finish disarm should hang until we resolve.
    slowDisarmArmed = true;
    onHoldRelease!();
    expect(gestures).toEqual(["hold-start", "hold-finish"]);
    await drain();
    expect(resolveHold1Disarm).not.toBeNull();

    // Hold 2 starts while hold-1 disarm IPC is still pending.
    gestures.length = 0;
    onEdge!("pressed");
    flush(2);
    expect(gestures).toEqual(["hold-start"]);
    // Arm queued behind slow disarm — not finished yet.
    expect(armCount).toBe(1);

    resolveHold1Disarm!();
    await drain();
    expect(armCount).toBe(2);

    // Spurious Carbon Released still ignored while hold-2 monitor owns finish.
    onEdge!("released");
    expect(gestures).toEqual(["hold-start"]);

    onHoldRelease!();
    expect(gestures).toEqual(["hold-start", "hold-finish"]);

    await controller.dispose();
  });

  it("fully disarms monitoring so a second hold re-arms cleanly", async () => {
    let onEdge: ((edge: "pressed" | "released") => void) | null = null;
    let onHoldRelease: (() => void) | null = null;
    let armed = false;
    const api: NativeShortcutApi = {
      isAvailable: () => true,
      async register(_hotkey, edge) {
        onEdge = edge;
      },
      async unregister() {},
      async unregisterAll() {},
    };
    const holdRelease: HoldReleaseApi = {
      isAvailable: () => true,
      arm: async () => {
        armed = true;
        return true;
      },
      disarm: async () => {
        armed = false;
      },
      listen: async (cb) => {
        onHoldRelease = cb;
        return () => undefined;
      },
    };
    const gestures: string[] = [];
    const { flush, scheduler } = makeTrackingScheduler();
    let now = 0;
    const controller = createNativeShortcutController({
      api,
      clock: () => now,
      holdMs: 10,
      holdRelease,
      onGesture: (g) => gestures.push(g),
      scheduler,
    });

    const drain = async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    };

    await controller.setShortcut("Ctrl + Shift + F");
    await drain();

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      gestures.length = 0;
      now += 1000;
      onEdge!("pressed");
      flush(cycle);
      await drain();
      expect(gestures).toEqual(["hold-start"]);
      expect(armed).toBe(true);
      onHoldRelease!();
      expect(gestures).toEqual(["hold-start", "hold-finish"]);
      await drain();
      expect(armed).toBe(false);
    }

    await controller.dispose();
  });
});
