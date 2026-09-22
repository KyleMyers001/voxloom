/**
 * Register-or-revert with last-known-good (ADR §1).
 * Pure async helper — callers supply register/unregister so unit tests
 * can mock without claiming native OS registration.
 */

export interface ShortcutBinder {
  register(hotkey: string): Promise<void>;
  unregister(hotkey: string): Promise<void>;
}

export type RegisterOutcome =
  | { ok: true; active: string; lastKnownGood: string }
  | {
      ok: false;
      active: string | null;
      attempted: string;
      lastKnownGood: string | null;
      message: string;
    };

export interface RegisterOrRevertInput {
  binder: ShortcutBinder;
  /** Currently OS-registered hotkey (plugin format), if any. */
  currentlyBound: string | null;
  /** Last successfully registered hotkey (plugin format). */
  lastKnownGood: string | null;
  /** Desired hotkey in plugin format. */
  next: string;
}

export async function registerOrRevert({
  binder,
  currentlyBound,
  lastKnownGood,
  next,
}: RegisterOrRevertInput): Promise<RegisterOutcome> {
  if (currentlyBound === next) {
    return { active: next, lastKnownGood: next, ok: true };
  }

  if (currentlyBound) {
    try {
      await binder.unregister(currentlyBound);
    } catch {
      // Best-effort unregister before attempting the new binding.
    }
  }

  try {
    await binder.register(next);
    return { active: next, lastKnownGood: next, ok: true };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    const message =
      `Could not bind “${next}” (${detail || "conflict or permission"}). ` +
      (lastKnownGood
        ? `Kept prior shortcut “${lastKnownGood}”.`
        : "No shortcut is active until a free combo is chosen.");

    if (lastKnownGood && lastKnownGood !== next) {
      try {
        await binder.register(lastKnownGood);
        return {
          active: lastKnownGood,
          attempted: next,
          lastKnownGood,
          message,
          ok: false,
        };
      } catch {
        return {
          active: null,
          attempted: next,
          lastKnownGood,
          message:
            message +
            " Re-bind of the prior shortcut also failed — gestures unbound.",
          ok: false,
        };
      }
    }

    return {
      active: null,
      attempted: next,
      lastKnownGood,
      message,
      ok: false,
    };
  }
}
