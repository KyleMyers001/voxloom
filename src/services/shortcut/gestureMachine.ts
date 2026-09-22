import type {
  Scheduler,
  ShortcutContext,
  ShortcutGesture,
} from "../contracts";
import { DOUBLE_TAP_MS, HOLD_MS } from "./constants";

export type KeyEdge = "pressed" | "released";

export interface GestureMachine {
  dispose(): void;
  /** Drive the machine from an abstract key edge (DOM or native). */
  handle(edge: KeyEdge): void;
  /** Clear hold/latch timers and tap memory without changing context. */
  resetPartial(): void;
  setContext(context: ShortcutContext): void;
}

export interface GestureMachineOptions {
  clock: () => number;
  doubleTapMs?: number;
  holdMs?: number;
  onGesture: (gesture: ShortcutGesture) => void;
  scheduler: Scheduler;
}

/**
 * Pure hold / double-tap latch state machine driven by Pressed/Released.
 * Timings match ADR provisional targets (320 ms / 260 ms).
 */
export function createGestureMachine({
  clock,
  doubleTapMs = DOUBLE_TAP_MS,
  holdMs = HOLD_MS,
  onGesture,
  scheduler,
}: GestureMachineOptions): GestureMachine {
  let downAt: number | null = null;
  let holdTimer: number | null = null;
  let holding = false;
  let ignoreUp = false;
  let latched = false;
  let lastTap: number | null = null;
  let tapTimer: number | null = null;
  let context: ShortcutContext = "product";
  let disposed = false;

  function clear(timer: number | null) {
    if (timer !== null) scheduler.clear(timer);
  }

  function resetPartial() {
    clear(holdTimer);
    clear(tapTimer);
    downAt = null;
    holdTimer = null;
    holding = false;
    ignoreUp = false;
    latched = false;
    lastTap = null;
    tapTimer = null;
  }

  function handlePressed() {
    if (disposed || context === null) return;
    if (downAt !== null) return;
    if (latched) {
      latched = false;
      ignoreUp = true;
      onGesture("latch-finish");
      return;
    }
    const current = clock();
    if (lastTap !== null && current - lastTap <= doubleTapMs) {
      clear(tapTimer);
      lastTap = null;
      latched = true;
      ignoreUp = true;
      onGesture("latch-start");
      return;
    }
    downAt = current;
    holdTimer = scheduler.set(() => {
      if (downAt === null) return;
      holding = true;
      onGesture("hold-start");
    }, holdMs);
  }

  function handleReleased() {
    if (disposed || context === null) return;
    if (ignoreUp) {
      ignoreUp = false;
      return;
    }
    clear(holdTimer);
    if (holding) {
      holding = false;
      onGesture("hold-finish");
    } else if (downAt !== null) {
      lastTap = clock();
      tapTimer = scheduler.set(() => {
        lastTap = null;
      }, doubleTapMs);
    }
    downAt = null;
  }

  return {
    dispose() {
      disposed = true;
      resetPartial();
    },
    handle(edge) {
      if (edge === "pressed") handlePressed();
      else handleReleased();
    },
    resetPartial,
    setContext(value) {
      if (context === value) return;
      context = value;
      resetPartial();
    },
  };
}
