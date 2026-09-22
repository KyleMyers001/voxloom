import { isTauri } from "@tauri-apps/api/core";
import type { Scheduler, ShortcutContext, ShortcutGesture } from "../contracts";
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
  /** True only while Mac hold-release monitor owns finish (arm returned true). */
  let holdWatchMonitoring = false;
  let context: ShortcutContext = "product";
  let unlistenHoldRelease: (() => void) | null = null;

  function disarmHoldWatch() {
    if (!holdWatchArmed) return;
    holdWatchArmed = false;
    holdWatchMonitoring = false;
    void holdRelease.disarm().catch(() => undefined);
  }

  function armHoldWatch() {
    if (!active || disposed) return;
    holdWatchArmed = true;
    holdWatchMonitoring = false;
    void holdRelease
      .arm(active)
      .then((monitoring) => {
        if (!holdWatchArmed || disposed) return;
        holdWatchMonitoring = monitoring;
      })
      .catch(() => {
        holdWatchArmed = false;
        holdWatchMonitoring = false;
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
        // While the Mac hold-release monitor owns finish, ignore OS Released.
        // Carbon often emits a spurious Released on app focus loss; trusting
        // it tears down listening/overlay even though the chord is still held.
        if (edge === "released" && holdWatchMonitoring) {
          return;
        }
        machine.handle(edge);
        // OS Released also tears down the hold watch (non-Mac / pre-monitor).
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

  // Serialize setShortcut so boot (mount + Settings effects) and Strict Mode
  // cannot race two RegisterEventHotKey calls for the same combo.
  let setShortcutQueue: Promise<unknown> = Promise.resolve();

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
      // Identical context must not disarm an in-progress hold (e.g. modal
      // subscribe re-fire, or boot setContext after setShortcut).
      if (context === ctx) return;
      context = ctx;
      disarmHoldWatch();
      machine.setContext(ctx);
    },
    async setShortcut(settingsShortcut) {
      const next = toPluginHotkey(settingsShortcut);
      const run = async (): Promise<RegisterOutcome> => {
        if (disposed) {
          return {
            active: null,
            attempted: next,
            lastKnownGood,
            message: "Shortcut controller disposed.",
            ok: false,
          };
        }
        // Same combo already ours (or prior queued call just bound it) —
        // do not unregister/re-register, bump generation, or toast.
        if (active === next) {
          return {
            active: next,
            lastKnownGood: lastKnownGood ?? next,
            ok: true,
          };
        }
        disarmHoldWatch();
        generation += 1;
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
      };
      const pending = setShortcutQueue.then(run, run);
      setShortcutQueue = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
  };
}
