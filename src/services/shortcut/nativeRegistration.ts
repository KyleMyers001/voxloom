import { isTauri } from "@tauri-apps/api/core";
import type { Scheduler, ShortcutGesture } from "../contracts";
import { DOUBLE_TAP_MS, HOLD_MS } from "./constants";
import { toPluginHotkey } from "./formatHotkey";
import { createGestureMachine, type GestureMachine } from "./gestureMachine";
import {
  createTauriHoldReleaseApi,
  type HoldReleaseApi,
} from "./holdReleaseBridge";
import {
  registerOrRevert,
  type RegisterOutcome,
  type ShortcutBinder,
} from "./registerOrRevert";

export interface NativeShortcutApi {
  isAvailable(): boolean;
  register(
    hotkey: string,
    onEdge: (edge: "pressed" | "released") => void,
  ): Promise<void>;
  unregister(hotkey: string): Promise<void>;
  unregisterAll(): Promise<void>;
}

/** Lazy-load Tauri plugin; no-op outside the desktop shell. */
export function createTauriShortcutApi(): NativeShortcutApi {
  return {
    isAvailable: () => isTauri(),
    async register(hotkey, onEdge) {
      const { register } = await import("@tauri-apps/plugin-global-shortcut");
      await register(hotkey, (event) => {
        if (event.state === "Pressed") onEdge("pressed");
        else if (event.state === "Released") onEdge("released");
      });
    },
    async unregister(hotkey) {
      const { unregister } = await import(
        "@tauri-apps/plugin-global-shortcut"
      );
      await unregister(hotkey);
    },
    async unregisterAll() {
      const { unregisterAll } = await import(
        "@tauri-apps/plugin-global-shortcut"
      );
      await unregisterAll();
    },
  };
}

export interface NativeShortcutController {
  activeHotkey(): string | null;
  dispose(): Promise<void>;
  lastKnownGood(): string | null;
  /**
   * Apply a Settings-format shortcut. On failure, re-binds last-known-good
   * and returns an honest outcome for Settings/toast.
   */
  setShortcut(settingsShortcut: string): Promise<RegisterOutcome>;
  setContext: GestureMachine["setContext"];
  resetPartial: GestureMachine["resetPartial"];
}

export interface NativeShortcutControllerOptions {
  api?: NativeShortcutApi;
  clock: () => number;
  doubleTapMs?: number;
  holdMs?: number;
  holdRelease?: HoldReleaseApi;
  onGesture: (gesture: ShortcutGesture) => void;
  onRegisterFailure?: (message: string) => void;
  scheduler: Scheduler;
}

export function createNativeShortcutController({
  api = createTauriShortcutApi(),
  clock,
  doubleTapMs = DOUBLE_TAP_MS,
  holdMs = HOLD_MS,
  holdRelease = createTauriHoldReleaseApi(),
  onGesture,
  onRegisterFailure,
  scheduler,
}: NativeShortcutControllerOptions): NativeShortcutController {
  let active: string | null = null;
  let lastKnownGood: string | null = null;
  let disposed = false;
  let generation = 0;
  let holdWatchArmed = false;
  let unlistenHoldRelease: (() => void) | null = null;

  function disarmHoldWatch() {
    if (!holdWatchArmed) return;
    holdWatchArmed = false;
    void holdRelease.disarm().catch(() => undefined);
  }

  function armHoldWatch() {
    if (!active || disposed) return;
    holdWatchArmed = true;
    void holdRelease.arm(active).catch(() => {
      holdWatchArmed = false;
    });
  }

  const machine = createGestureMachine({
    clock,
    doubleTapMs,
    holdMs,
    onGesture: (gesture) => {
      if (gesture === "hold-start") {
        // Mac: HotKey Released often missing when modifiers lift first.
        armHoldWatch();
      } else if (
        gesture === "hold-finish" ||
        gesture === "latch-start" ||
        gesture === "latch-finish"
      ) {
        // Latch paths and hold end do not keep the watch.
        disarmHoldWatch();
      }
      onGesture(gesture);
    },
    scheduler,
  });

  const binder: ShortcutBinder = {
    async register(hotkey) {
      const gen = generation;
      await api.register(hotkey, (edge) => {
        if (disposed || gen !== generation) return;
        machine.handle(edge);
        // OS Released also tears down the hold watch.
        if (edge === "released") disarmHoldWatch();
      });
    },
    async unregister(hotkey) {
      await api.unregister(hotkey);
    },
  };

  // Synthetic Released from Mac hold-release watch → same machine path.
  void holdRelease.listen(() => {
    if (disposed) return;
    machine.handle("released");
    disarmHoldWatch();
  }).then((unlisten) => {
    if (disposed) {
      unlisten();
      return;
    }
    unlistenHoldRelease = unlisten;
  }).catch(() => undefined);

  return {
    activeHotkey: () => active,
    async dispose() {
      disposed = true;
      disarmHoldWatch();
      unlistenHoldRelease?.();
      unlistenHoldRelease = null;
      machine.dispose();
      generation += 1;
      try {
        if (active) await api.unregister(active);
        else await api.unregisterAll();
      } catch {
        // Best-effort shutdown unregister.
      }
      active = null;
    },
    lastKnownGood: () => lastKnownGood,
    resetPartial: () => {
      disarmHoldWatch();
      machine.resetPartial();
    },
    setContext: (ctx) => {
      disarmHoldWatch();
      machine.setContext(ctx);
    },
    async setShortcut(settingsShortcut) {
      if (disposed) {
        return {
          active: null,
          attempted: toPluginHotkey(settingsShortcut),
          lastKnownGood,
          message: "Shortcut controller disposed.",
          ok: false,
        };
      }
      disarmHoldWatch();
      generation += 1;
      const next = toPluginHotkey(settingsShortcut);
      const outcome = await registerOrRevert({
        binder,
        currentlyBound: active,
        lastKnownGood,
        next,
      });
      if (outcome.ok) {
        active = outcome.active;
        lastKnownGood = outcome.lastKnownGood;
      } else {
        active = outcome.active;
        if (outcome.message) onRegisterFailure?.(outcome.message);
      }
      return outcome;
    },
  };
}
