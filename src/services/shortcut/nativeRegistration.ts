import type { ShortcutContext } from '../contracts';
import {
  DOUBLE_TAP_MS,
  HOLD_MS,
  HOLD_RELEASE_CARBON_GRACE_MS,
} from './constants';
import { toPluginHotkey } from './formatHotkey';
import { createGestureMachine } from './gestureMachine';
import { createTauriHoldReleaseApi } from './holdReleaseBridge';
import { createHoldWatch } from './holdWatch';
import type { ShortcutBinder } from './registerOrRevert';
import type {
  NativeShortcutController,
  NativeShortcutControllerOptions,
} from './nativeShortcutTypes';
import type { RegistrationState } from './registrationState';
import { runSetShortcut } from './setShortcutRun';
import { isDictationSuspended } from './recordingSuspend';
import { runSuspendBinding } from './suspendBinding';
import { createTauriShortcutApi } from './tauriShortcutApi';

export type { NativeShortcutApi } from './tauriShortcutApi';
export { createTauriShortcutApi } from './tauriShortcutApi';
export type {
  NativeShortcutController,
  NativeShortcutControllerOptions,
} from './nativeShortcutTypes';

export function createNativeShortcutController({
  api = createTauriShortcutApi(),
  carbonReleaseGraceMs = HOLD_RELEASE_CARBON_GRACE_MS,
  clock,
  doubleTapMs = DOUBLE_TAP_MS,
  holdMs = HOLD_MS,
  holdRelease = createTauriHoldReleaseApi(),
  onGesture,
  onRegisterFailure,
  onSuspendFailure,
  onSuspendRecovered,
  scheduler,
}: NativeShortcutControllerOptions): NativeShortcutController {
  let active: string | null = null;
  /** Hotkey unbound by suspendBinding(true), re-bound on resume. */
  let suspendedHotkey: string | null = null;
  /** suspendBinding(true) is in effect (a recorder is recording). */
  let recording = false;
  /** A resume re-bind failure was reported; report the recovery too. */
  let rebindFailed = false;
  let lastKnownGood: string | null = null;
  let disposed = false;
  let generation = 0;
  let context: ShortcutContext = 'product';
  let unlistenHoldRelease: (() => void) | null = null;

  const holdWatch = createHoldWatch({
    carbonReleaseGraceMs,
    getActive: () => active,
    holdRelease,
    isDisposed: () => disposed,
    onFlushSuppressed: () => finishFromCarbonReleased(),
    scheduler,
  });

  const machine = createGestureMachine({
    clock,
    doubleTapMs,
    holdMs,
    onGesture: (gesture) => {
      if (gesture === 'hold-start') {
        // Mac: HotKey Released often missing when modifiers lift first.
        // Not while a recorder records: that start is dropped downstream.
        if (!isDictationSuspended()) holdWatch.arm();
      } else if (
        gesture === 'hold-finish'
        || gesture === 'latch-start'
        || gesture === 'latch-finish'
      ) {
        // Latch paths and hold end do not keep the watch.
        holdWatch.disarm();
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
    holdWatch.disarm();
  }

  const binder: ShortcutBinder = {
    async register(hotkey) {
      const gen = generation;
      await api.register(hotkey, (edge) => {
        if (disposed || gen !== generation) return;
        // Post-arm grace only: ignore spurious Carbon Released (~focus loss).
        // After grace, Carbon is backup finish even while poll/tap monitors —
        // a dead 2nd-session Rust watch must not leave Home on Stop forever.
        if (edge === 'released' && holdWatch.suppressCarbonReleased()) {
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
    holdWatch.disarm();
  }).then((unlisten) => {
    if (disposed) {
      unlisten();
      return;
    }
    unlistenHoldRelease = unlisten;
  }).catch(() => undefined);

  // Serialize setShortcut / suspendBinding so boot (mount + Settings effects)
  // and Strict Mode cannot race two RegisterEventHotKey calls for the same combo.
  let setShortcutQueue: Promise<unknown> = Promise.resolve();

  const state: RegistrationState = {
    getActive: () => active,
    setActive: (hotkey: string | null) => { active = hotkey; },
    getSuspendedHotkey: () => suspendedHotkey,
    setSuspendedHotkey: (hotkey: string | null) => { suspendedHotkey = hotkey; },
    getLastKnownGood: () => lastKnownGood,
    setLastKnownGood: (hotkey: string | null) => { lastKnownGood = hotkey; },
    getRecording: () => recording,
    setRecording: (on: boolean) => { recording = on; },
    getRebindFailed: () => rebindFailed,
    setRebindFailed: (v: boolean) => { rebindFailed = v; },
    isDisposed: () => disposed,
    bumpGeneration: () => { generation += 1; },
    api,
    binder,
    machine,
    disarmHoldWatch: () => holdWatch.disarm(),
    onRegisterFailure,
    onSuspendFailure,
    onSuspendRecovered,
  };

  return {
    activeHotkey: () => active,
    async dispose() {
      disposed = true;
      holdWatch.disarm();
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
      holdWatch.disarm();
      machine.resetPartial();
    },
    setContext: (ctx) => {
      // Identical context must not disarm an in-progress hold (e.g. modal
      // subscribe re-fire, or boot setContext after setShortcut).
      if (context === ctx) return;
      context = ctx;
      holdWatch.disarm();
      machine.setContext(ctx);
    },
    suspendBinding(on) {
      const pending = setShortcutQueue.then(
        () => runSuspendBinding(on, state),
        () => runSuspendBinding(on, state),
      );
      setShortcutQueue = pending.catch(() => undefined);
      return pending;
    },
    async setShortcut(settingsShortcut) {
      const next = toPluginHotkey(settingsShortcut);
      const run = () => runSetShortcut(next, state);
      const pending = setShortcutQueue.then(run, run);
      setShortcutQueue = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
  };
}
