import type { RegistrationState } from './registrationState';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * BUS-69: unbind the OS hotkey while a recorder records (Carbon hotkeys
 * swallow the keystroke), and re-bind it afterwards.
 */
export async function runSuspendBinding(
  on: boolean,
  s: RegistrationState,
): Promise<void> {
  if (s.isDisposed()) return;
  s.setRecording(on);
  if (on) {
    const active = s.getActive();
    if (!active || s.getSuspendedHotkey()) return;
    try {
      await s.api.unregister(active);
    } catch (err) {
      // The OS may still hold it: stay bound (gesture state intact, so
      // the shortcut still stops a dictation) and say so, rather than
      // marking it suspended and later "re-binding" a live hotkey.
      s.onSuspendFailure?.('unbind', errorText(err));
      return;
    }
    s.bumpGeneration();
    s.setActive(null);
    s.setSuspendedHotkey(active);
    // A hold/latch started before recording must end with its normal
    // finish, or (with the hotkey unbound) nothing could stop the mic.
    // Finishes pass suspendable(); only starts are swallowed.
    s.machine.finishActive();
    s.disarmHoldWatch();
    return;
  }
  const hotkey = s.getSuspendedHotkey();
  // A save during recording already bound the new combo.
  if (!hotkey || s.getActive()) {
    s.setSuspendedHotkey(null);
    // BUS-74: the combo is bound again; a stale failure must not linger.
    s.setRebindFailed(false);
    return;
  }
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (s.isDisposed()) return;
    try {
      await s.binder.register(hotkey);
      s.setActive(hotkey);
      s.setSuspendedHotkey(null);
      if (s.getRebindFailed()) {
        s.setRebindFailed(false);
        s.onSuspendRecovered?.();
      }
      return;
    } catch (err) {
      lastError = err;
    }
  }
  // Keep suspendedHotkey so the next resume retries it; report the
  // inactive state so Settings and Home show it.
  const message = errorText(lastError);
  s.setRebindFailed(true);
  s.onRegisterFailure?.(message);
  s.onSuspendFailure?.('rebind', message);
}
