import { isTauri } from "@tauri-apps/api/core";
import type { Scheduler, ShortcutGesture } from "../contracts";
import { DOUBLE_TAP_MS, HOLD_MS } from "./constants";
import { toPluginHotkey } from "./formatHotkey";
import { createGestureMachine, type GestureMachine } from "./gestureMachine";
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
  onGesture: (gesture: ShortcutGesture) => void;
  onRegisterFailure?: (message: string) => void;
  scheduler: Scheduler;
}

export function createNativeShortcutController({
  api = createTauriShortcutApi(),
  clock,
  doubleTapMs = DOUBLE_TAP_MS,
  holdMs = HOLD_MS,
  onGesture,
  onRegisterFailure,
  scheduler,
}: NativeShortcutControllerOptions): NativeShortcutController {
  const machine = createGestureMachine({
    clock,
    doubleTapMs,
    holdMs,
    onGesture,
    scheduler,
  });

  let active: string | null = null;
  let lastKnownGood: string | null = null;
  let disposed = false;
  let generation = 0;

  const binder: ShortcutBinder = {
    async register(hotkey) {
      const gen = generation;
      await api.register(hotkey, (edge) => {
        if (disposed || gen !== generation) return;
        machine.handle(edge);
      });
    },
    async unregister(hotkey) {
      await api.unregister(hotkey);
    },
  };

  return {
    activeHotkey: () => active,
    async dispose() {
      disposed = true;
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
    resetPartial: () => machine.resetPartial(),
    setContext: (ctx) => machine.setContext(ctx),
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
