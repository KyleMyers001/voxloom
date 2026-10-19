import { registerOrRevert, type RegisterOutcome } from './registerOrRevert';
import type { RegistrationState } from './registrationState';

/** One queued setShortcut: bind `next`, reverting to last-known-good on failure. */
export async function runSetShortcut(
  next: string,
  s: RegistrationState,
): Promise<RegisterOutcome> {
  if (s.isDisposed()) {
    return {
      active: null,
      attempted: next,
      lastKnownGood: s.getLastKnownGood(),
      message: 'Shortcut controller disposed.',
      ok: false,
    };
  }
  // Same combo already ours (or prior queued call just bound it) —
  // do not unregister/re-register, bump generation, or toast.
  if (s.getActive() === next) {
    return {
      active: next,
      lastKnownGood: s.getLastKnownGood() ?? next,
      ok: true,
    };
  }
  s.disarmHoldWatch();
  s.bumpGeneration();
  const outcome = await registerOrRevert({
    binder: s.binder,
    currentlyBound: s.getActive(),
    lastKnownGood: s.getLastKnownGood(),
    next,
  });
  s.setActive(outcome.active);
  if (outcome.ok) {
    s.setLastKnownGood(outcome.lastKnownGood);
    // Outside recording, a stale suspended combo must not be re-bound
    // later over the one just saved.
    if (!s.getRecording()) {
      s.setSuspendedHotkey(null);
      s.setRebindFailed(false);
    }
  } else if (outcome.message) {
    s.onRegisterFailure?.(outcome.message);
  }
  return outcome;
}
