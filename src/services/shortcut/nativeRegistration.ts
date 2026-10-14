import { isTauri } from '@tauri-apps/api/core';
import type { Scheduler, ShortcutContext, ShortcutGesture } from '../contracts';
import {
  DOUBLE_TAP_MS,
  HOLD_MS,
  HOLD_RELEASE_CARBON_GRACE_MS,
} from './constants';
import { toPluginHotkey } from './formatHotkey';
import { createGestureMachine, type GestureMachine } from './gestureMachine';
import {
  createTauriHoldReleaseApi,
  type HoldReleaseApi,
} from './holdReleaseBridge';
import {
  registerOrRevert,
  type RegisterOutcome,
  type ShortcutBinder,
} from './registerOrRevert';
import { isDictationSuspended } from './recordingSuspend';

export interface NativeShortcutApi {
  isAvailable(): boolean;
  register(
    hotkey: string,
    onEdge: (edge: 'pressed' | 'released') => void,
  ): Promise<void>;
  unregister(hotkey: string): Promise<void>;
  unregisterAll(): Promise<void>;
}

/** Lazy-load Tauri plugin; no-op outside the desktop shell. */
export function createTauriShortcutApi(): NativeShortcutApi {
  return {
    isAvailable: () => isTauri(),
    async register(hotkey, onEdge) {
      const { register } = await import('@tauri-apps/plugin-global-shortcut');
      await register(hotkey, (event) => {
        if (event.state === 'Pressed') onEdge('pressed');
        else if (event.state === 'Released') onEdge('released');
      });
    },
    async unregister(hotkey) {
      const { unregister } = await import(
        '@tauri-apps/plugin-global-shortcut'
      );
      await unregister(hotkey);
    },
    async unregisterAll() {
      const { unregisterAll } = await import(
        '@tauri-apps/plugin-global-shortcut'
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
  /**
   * BUS-69: unbind the OS hotkey while a recorder records (Carbon hotkeys
   * swallow the keystroke, so the recorder would never see the current
   * combo), and re-bind it afterwards.
   */
  suspendBinding(on: boolean): Promise<void>;
  setContext: GestureMachine['setContext'];
  resetPartial: GestureMachine['resetPartial'];
}

export interface NativeShortcutControllerOptions {
  api?: NativeShortcutApi;
  /**
   * Post-arm ms to ignore Carbon Released (spurious focus race). After this,
   * Carbon Released finishes even while the Mac poll/tap watch monitors.
   */
  carbonReleaseGraceMs?: number;
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
  carbonReleaseGraceMs = HOLD_RELEASE_CARBON_GRACE_MS,
  clock,
  doubleTapMs = DOUBLE_TAP_MS,
  holdMs = HOLD_MS,
  holdRelease = createTauriHoldReleaseApi(),
  onGesture,
  onRegisterFailure,
  scheduler,
}: NativeShortcutControllerOptions): NativeShortcutController {
  let active: string | null = null;
  /** Hotkey unbound by suspendBinding(true), re-bound on resume. */
  let suspendedHotkey: string | null = null;
  let lastKnownGood: string | null = null;
  let disposed = false;
  let generation = 0;
  let holdWatchArmed = false;
  /**
   * True while the Mac hold-release poll/tap watch is the *primary* finish
   * path. Carbon Released is only suppressed during a short post-arm grace;
   * after grace it is a backup finish (Clara: dead 2nd-session watch).
   */
  let holdWatchMonitoring = false;
  /** Suppress Carbon Released only during post-arm grace (spurious focus). */
  let carbonReleaseGraceActive = false;
  let carbonReleaseGraceTimer: number | null = null;
  /** OS Released seen during grace; flush if arm declines monitoring. */
  let suppressedOsReleased = false;
  let context: ShortcutContext = 'product';
  let unlistenHoldRelease: (() => void) | null = null;
  /** Flush suppressed Carbon Released if arm declines monitoring (non-Mac). */
  let flushSuppressedOsRelease: (() => void) | null = null;
  /**
   * Generation + serial queue so a late disarm from hold N cannot kill the
   * Rust watch for hold N+1. Alone this was not enough on device (c9e0df5);
   * Carbon backup after grace is required.
   */
  let holdWatchGeneration = 0;
  let holdWatchChain: Promise<void> = Promise.resolve();

  function enqueueHoldWatch(op: () => Promise<void>): void {
    holdWatchChain = holdWatchChain.then(op, op);
  }

  function clearCarbonReleaseGrace() {
    if (carbonReleaseGraceTimer !== null) {
      scheduler.clear(carbonReleaseGraceTimer);
      carbonReleaseGraceTimer = null;
    }
    carbonReleaseGraceActive = false;
  }

  function beginCarbonReleaseGrace() {
    clearCarbonReleaseGrace();
    carbonReleaseGraceActive = true;
    carbonReleaseGraceTimer = scheduler.set(() => {
      carbonReleaseGraceTimer = null;
      carbonReleaseGraceActive = false;
    }, carbonReleaseGraceMs);
  }

  function disarmHoldWatch() {
    // Idempotent: hold-finish + listen both call disarm; a second call must
    // not bump generation or the queued Rust disarm becomes a no-op skip.
    if (!holdWatchArmed && !holdWatchMonitoring) return;
    holdWatchArmed = false;
    holdWatchMonitoring = false;
    suppressedOsReleased = false;
    clearCarbonReleaseGrace();
    const gen = ++holdWatchGeneration;
    enqueueHoldWatch(async () => {
      if (gen !== holdWatchGeneration) return;
      await holdRelease.disarm().catch(() => undefined);
    });
  }

  function armHoldWatch() {
    if (!active || disposed) return;
    const hotkey = active;
    const gen = ++holdWatchGeneration;
    holdWatchArmed = true;
    // Optimistic monitoring for poll/tap primary; grace covers the known
    // Carbon Released-after-arm spurious edge (~20ms focus race).
    holdWatchMonitoring = true;
    suppressedOsReleased = false;
    beginCarbonReleaseGrace();
    enqueueHoldWatch(async () => {
      if (gen !== holdWatchGeneration || disposed) return;
      try {
        const monitoring = await holdRelease.arm(hotkey);
        if (gen !== holdWatchGeneration || disposed) {
          // Superseded (e.g. finish then re-arm) — do not leave a stray watch.
          await holdRelease.disarm().catch(() => undefined);
          return;
        }
        holdWatchArmed = true;
        holdWatchMonitoring = monitoring;
        if (!monitoring) {
          // Non-Mac / monitor declined: OS Released remains authoritative.
          clearCarbonReleaseGrace();
          if (suppressedOsReleased) {
            suppressedOsReleased = false;
            flushSuppressedOsRelease?.();
          }
        } else {
          suppressedOsReleased = false;
        }
      } catch {
        if (gen !== holdWatchGeneration || disposed) return;
        // Arm failed — never leave monitoring=true with a dead watch.
        holdWatchArmed = false;
        holdWatchMonitoring = false;
        clearCarbonReleaseGrace();
        if (suppressedOsReleased) {
          suppressedOsReleased = false;
          flushSuppressedOsRelease?.();
        }
      }
    });
  }

  const machine = createGestureMachine({
    clock,
    doubleTapMs,
    holdMs,
    onGesture: (gesture) => {
      if (gesture === 'hold-start') {
        // Mac: HotKey Released often missing when modifiers lift first.
        // Not while a recorder records: that start is dropped downstream.
        if (!isDictationSuspended()) armHoldWatch();
      } else if (
        gesture === 'hold-finish' ||
        gesture === 'latch-start' ||
        gesture === 'latch-finish'
      ) {
        // Latch paths and hold end do not keep the watch.
        disarmHoldWatch();
      }
      onGesture(gesture);
    },
    scheduler,
  });

  function finishFromCarbonReleased() {
    if (import.meta.env.DEV) {
      console.debug('[hold-release] emit source=carbon-released');
    }
    machine.handle('released');
    disarmHoldWatch();
  }

  flushSuppressedOsRelease = () => {
    finishFromCarbonReleased();
  };

  const binder: ShortcutBinder = {
    async register(hotkey) {
      const gen = generation;
      await api.register(hotkey, (edge) => {
        if (disposed || gen !== generation) return;
        // Post-arm grace only: ignore spurious Carbon Released (~focus loss).
        // After grace, Carbon is backup finish even while poll/tap monitors —
        // a dead 2nd-session Rust watch must not leave Home on Stop forever.
        if (
          edge === 'released'
          && holdWatchMonitoring
          && carbonReleaseGraceActive
        ) {
          suppressedOsReleased = true;
          if (import.meta.env.DEV) {
            console.debug('[hold-release] ignore source=carbon-released');
          }
          return;
        }
        if (edge === 'released') {
          finishFromCarbonReleased();
          return;
        }
        machine.handle(edge);
      });
    },
    async unregister(hotkey) {
      await api.unregister(hotkey);
    },
  };

  // Synthetic Released from Mac hold-release watch → same machine path.
  void holdRelease.listen(() => {
    if (disposed) return;
    machine.handle('released');
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
    suspendBinding(on) {
      const run = async () => {
        if (disposed) return;
        if (on) {
          if (!active || suspendedHotkey) return;
          const hotkey = active;
          disarmHoldWatch();
          machine.resetPartial();
          generation += 1;
          active = null;
          suspendedHotkey = hotkey;
          await api.unregister(hotkey).catch(() => undefined);
          return;
        }
        const hotkey = suspendedHotkey;
        suspendedHotkey = null;
        // A save during recording already bound the new combo.
        if (!hotkey || active) return;
        try {
          await binder.register(hotkey);
          active = hotkey;
        } catch (err) {
          onRegisterFailure?.(err instanceof Error ? err.message : String(err));
        }
      };
      const pending = setShortcutQueue.then(run, run);
      setShortcutQueue = pending.catch(() => undefined);
      return pending;
    },
    async setShortcut(settingsShortcut) {
      const next = toPluginHotkey(settingsShortcut);
      const run = async (): Promise<RegisterOutcome> => {
        if (disposed) {
          return {
            active: null,
            attempted: next,
            lastKnownGood,
            message: 'Shortcut controller disposed.',
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
