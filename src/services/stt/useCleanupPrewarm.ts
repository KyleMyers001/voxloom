/// When to prewarm the cleanup model (BUS-16 3c-2c C2): every time cleanup
/// is switched on, and once after launch if it was already on, a little
/// later (PREWARM_LAUNCH_DELAY_MS). Settings that hydrate at boot are the
/// launch state, not a switch-on. Switching off cancels a pending launch
/// prewarm and disarms one that is running (BUS-121), and a switch-on right
/// after waits for that disarm, so it can't end the new prewarm. The plan lives in a ref, so StrictMode's effect replay neither
/// loses nor repeats a prewarm.

import { useEffect, useRef } from 'react';
import {
  PREWARM_LAUNCH_DELAY_MS,
  type DisarmPrewarm,
  type Prewarm,
  type PrewarmTrigger,
} from '../cleanup/prewarm';

export interface CleanupPrewarmOptions {
  /** `isCleanupActive(settings)`. */
  active: boolean;
  /** Durable settings have hydrated (bootReady). */
  ready: boolean;
  /** Native only; absent in the browser build. Must be stable. */
  prewarm?: Prewarm;
  /** Native only, like `prewarm`. Must be stable. */
  disarm?: DisarmPrewarm;
}

interface Plan {
  /** `active` when last seen ready; null until launch. */
  seen: boolean | null;
  launchPending: boolean;
}

export function useCleanupPrewarm({ active, disarm, ready, prewarm }: CleanupPrewarmOptions): void {
  const plan = useRef<Plan>({ launchPending: false, seen: null });
  /** The disarm in flight, so the next prewarm starts after it. */
  const disarming = useRef<Promise<void> | null>(null);
  useEffect(() => {
    if (!ready || !prewarm) return undefined;
    const fire = (trigger: PrewarmTrigger) => {
      const pending = disarming.current;
      const started = pending ? pending.then(() => prewarm(trigger)) : prewarm(trigger);
      void started.catch(() => {
        // Best effort: the first dictation simply loads the model itself.
      });
    };
    const stop = () => {
      if (!disarm) return;
      // Best effort: a prewarm that outlives the switch ends at its own
      // warm-up reply or timeout, and a dictation never waits on it.
      const done: Promise<void> = disarm()
        .then(() => undefined, () => undefined)
        .finally(() => {
          if (disarming.current === done) disarming.current = null;
        });
      disarming.current = done;
    };
    const current = plan.current;
    if (current.seen === null) {
      current.launchPending = active;
    } else if (active !== current.seen) {
      current.launchPending = false;
      if (active) fire('switch-on');
      else stop();
    }
    current.seen = active;
    if (!current.launchPending) return undefined;
    const timer = setTimeout(() => {
      current.launchPending = false;
      fire('launch');
    }, PREWARM_LAUNCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [active, disarm, prewarm, ready]);
}
