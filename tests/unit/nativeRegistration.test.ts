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
    arm: async () => undefined,
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
