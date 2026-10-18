import type { Scheduler } from '../contracts';
import type { HoldReleaseApi } from './holdReleaseBridge';

export interface HoldWatchOptions {
  carbonReleaseGraceMs: number;
  /** Hotkey currently bound, or null. */
  getActive: () => string | null;
  holdRelease: HoldReleaseApi;
  isDisposed: () => boolean;
  /** Finish a Carbon Released suppressed during grace once arm declines monitoring. */
  onFlushSuppressed: () => void;
  scheduler: Scheduler;
}

export interface HoldWatch {
  arm(): void;
  disarm(): void;
  /**
   * Post-arm grace only: true (and remembered) when a Carbon Released must be
   * ignored as the spurious focus-loss edge. After grace, Carbon is a backup
   * finish even while poll/tap monitors.
   */
  suppressCarbonReleased(): boolean;
}

/** Mac hold-release poll/tap watch plus the Carbon Released grace window. */
export function createHoldWatch({
  carbonReleaseGraceMs, getActive, holdRelease, isDisposed, onFlushSuppressed, scheduler,
}: HoldWatchOptions): HoldWatch {
  let armed = false;
  /**
   * True while the Mac hold-release poll/tap watch is the *primary* finish
   * path. Carbon Released is only suppressed during a short post-arm grace;
   * after grace it is a backup finish (dead 2nd-session watch).
   */
  let monitoring = false;
  /** Suppress Carbon Released only during post-arm grace (spurious focus). */
  let graceActive = false;
  let graceTimer: number | null = null;
  /** OS Released seen during grace; flush if arm declines monitoring. */
  let suppressedOsReleased = false;
  /**
   * Generation + serial queue so a late disarm from hold N cannot kill the
   * Rust watch for hold N+1. Alone this was not enough on device (c9e0df5);
   * Carbon backup after grace is required.
   */
  let watchGeneration = 0;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (op: () => Promise<void>) => {
    chain = chain.then(op, op);
  };

  function clearGrace() {
    if (graceTimer !== null) {
      scheduler.clear(graceTimer);
      graceTimer = null;
    }
    graceActive = false;
  }

  function beginGrace() {
    clearGrace();
    graceActive = true;
    graceTimer = scheduler.set(() => {
      graceTimer = null;
      graceActive = false;
    }, carbonReleaseGraceMs);
  }

  function flushIfSuppressed() {
    if (suppressedOsReleased) {
      suppressedOsReleased = false;
      onFlushSuppressed();
    }
  }

  function disarm() {
    // Idempotent: hold-finish + listen both call disarm; a second call must
    // not bump generation or the queued Rust disarm becomes a no-op skip.
    if (!armed && !monitoring) return;
    armed = false;
    monitoring = false;
    suppressedOsReleased = false;
    clearGrace();
    const gen = ++watchGeneration;
    enqueue(async () => {
      if (gen !== watchGeneration) return;
      await holdRelease.disarm().catch(() => undefined);
    });
  }

  function arm() {
    const hotkey = getActive();
    if (!hotkey || isDisposed()) return;
    const gen = ++watchGeneration;
    armed = true;
    // Optimistic monitoring for poll/tap primary; grace covers the known
    // Carbon Released-after-arm spurious edge (~20ms focus race).
    monitoring = true;
    suppressedOsReleased = false;
    beginGrace();
    enqueue(async () => {
      if (gen !== watchGeneration || isDisposed()) return;
      try {
        const nowMonitoring = await holdRelease.arm(hotkey);
        if (gen !== watchGeneration || isDisposed()) {
          // Superseded (e.g. finish then re-arm) — do not leave a stray watch.
          await holdRelease.disarm().catch(() => undefined);
          return;
        }
        armed = true;
        monitoring = nowMonitoring;
        if (!nowMonitoring) {
          // Non-Mac / monitor declined: OS Released remains authoritative.
          clearGrace();
          flushIfSuppressed();
        } else {
          suppressedOsReleased = false;
        }
      } catch {
        if (gen !== watchGeneration || isDisposed()) return;
        // Arm failed — never leave monitoring=true with a dead watch.
        armed = false;
        monitoring = false;
        clearGrace();
        flushIfSuppressed();
      }
    });
  }

  return {
    arm,
    disarm,
    suppressCarbonReleased() {
      if (!(monitoring && graceActive)) return false;
      suppressedOsReleased = true;
      return true;
    },
  };
}
