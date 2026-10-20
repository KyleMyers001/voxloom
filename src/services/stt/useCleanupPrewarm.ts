/// When to prewarm the cleanup model (BUS-16 3c-2c C2): every time cleanup
/// is switched on, and once after launch if it was already on, a little
/// later (PREWARM_LAUNCH_DELAY_MS). Settings that hydrate at boot are the
/// launch state, not a switch-on. Switching off cancels a pending launch
/// prewarm. The plan lives in a ref, so StrictMode's effect replay neither
/// loses nor repeats a prewarm.

import { useEffect, useRef } from 'react';
import { PREWARM_LAUNCH_DELAY_MS, type Prewarm, type PrewarmTrigger } from '../cleanup/prewarm';

export interface CleanupPrewarmOptions {
  /** `isCleanupActive(settings)`. */
  active: boolean;
  /** Durable settings have hydrated (bootReady). */
  ready: boolean;
  /** Native only; absent in the browser build. Must be stable. */
  prewarm?: Prewarm;
}

interface Plan {
  /** `active` when last seen ready; null until launch. */
  seen: boolean | null;
  launchPending: boolean;
}

export function useCleanupPrewarm({ active, ready, prewarm }: CleanupPrewarmOptions): void {
  const plan = useRef<Plan>({ launchPending: false, seen: null });
  useEffect(() => {
    if (!ready || !prewarm) return undefined;
    const fire = (trigger: PrewarmTrigger) => {
      void prewarm(trigger).catch(() => {
        // Best effort: the first dictation simply loads the model itself.
      });
    };
    const current = plan.current;
    if (current.seen === null) {
      current.launchPending = active;
    } else if (active !== current.seen) {
      current.launchPending = false;
      if (active) fire('switch-on');
    }
    current.seen = active;
    if (!current.launchPending) return undefined;
    const timer = setTimeout(() => {
      current.launchPending = false;
      fire('launch');
    }, PREWARM_LAUNCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [active, prewarm, ready]);
}
