import { type Dispatch, type MutableRefObject, useEffect, useRef } from 'react';
import type { Settings } from '../domain/types';
import { SETTINGS_FILE_VERSION, type DurableSettingsStore, type SettingsFile } from '../services/settings';
import type { AppAction } from './actions';

interface Options {
  allowRef: MutableRefObject<boolean>;
  dispatch: Dispatch<AppAction>;
  hydratedRef: MutableRefObject<boolean>;
  /** Last value handed to save(); the "nothing changed" check uses this. */
  lastRequestedRef: MutableRefObject<SettingsFile | null>;
  /** Last value confirmed on disk; the rollback target. */
  lastSavedRef: MutableRefObject<SettingsFile | null>;
  onboardingComplete: boolean;
  persistence: { enabled: boolean; store: DurableSettingsStore };
  persistGenRef: MutableRefObject<number>;
  settings: Settings;
  /** AppProvider clock; defaults to Date.now for standalone call sites. */
  now?: () => number;
}

const same = (a: SettingsFile | null, b: SettingsFile) =>
  a !== null && a.onboardingComplete === b.onboardingComplete
    && JSON.stringify(a.settings) === JSON.stringify(b.settings);

/**
 * Persist settings after hydrate whenever settings or onboarding-complete
 * change. Optimistic UI with rollback to the last successful save on failure.
 * Skips only when the value equals the last REQUESTED save, so A→B→A with B
 * still in flight still writes the final A. Saves run one at a time, in order.
 */
export function useSettingsPersist({
  allowRef, dispatch, hydratedRef, lastRequestedRef, lastSavedRef,
  onboardingComplete, persistence, persistGenRef, settings, now = Date.now,
}: Options) {
  const chain = useRef<Promise<void>>(Promise.resolve());
  const nowRef = useRef(now);
  nowRef.current = now;
  useEffect(() => {
    if (!persistence.enabled || !hydratedRef.current || !allowRef.current) return;
    const snapshot: SettingsFile = { onboardingComplete, settings, version: SETTINGS_FILE_VERSION };
    if (same(lastRequestedRef.current, snapshot)) return;
    lastRequestedRef.current = snapshot;
    const gen = persistGenRef.current;
    const run = async () => {
      try {
        await persistence.store.save(snapshot.settings, snapshot.onboardingComplete);
        if (gen !== persistGenRef.current) return;
        lastSavedRef.current = snapshot;
        dispatch({ message: null, type: 'set-settings-error' });
      } catch (error: unknown) {
        if (gen !== persistGenRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        const rollback = lastSavedRef.current;
        // Roll back only if no newer save is queued: a queued save carries the
        // UI's current value and will be written next, so rolling the UI back
        // now would leave the screen and the disk disagreeing.
        if (rollback && lastRequestedRef.current === snapshot) {
          // The rollback is what we now expect on disk; don't re-save it.
          lastRequestedRef.current = rollback;
          dispatch({
            onboardingComplete: rollback.onboardingComplete,
            settings: rollback.settings,
            now: nowRef.current(),
            type: 'hydrate-settings',
          });
        }
        dispatch({ message: `Failed to save settings: ${message}`, type: 'set-settings-error' });
      }
    };
    chain.current = chain.current.then(run, run);
  }, [allowRef, dispatch, hydratedRef, lastRequestedRef, lastSavedRef, onboardingComplete,
    persistence, persistGenRef, settings]);
}
