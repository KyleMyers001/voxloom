import { type Dispatch, type MutableRefObject, useEffect, useRef } from 'react';
import type { Settings } from '../domain/types';
import { parseSettingsJson, type SettingsFile } from '../services/settings';
import { listenSettingsChanged, subscribe } from '../services/settingsWindow';
import type { AppAction } from './actions';

interface Options {
  enabled: boolean;
  dispatch: Dispatch<AppAction>;
  lastSavedRef: MutableRefObject<SettingsFile | null>;
  /** Last value this window asked to save; a foreign save becomes it too. */
  lastRequestedRef?: MutableRefObject<SettingsFile | null>;
  persistGenRef: MutableRefObject<number>;
  /**
   * Write permission for this window. A valid file saved by another window
   * supersedes whatever this window could not read, so it re-enables writes.
   */
  allowRef?: MutableRefObject<boolean>;
  /** This window's current (possibly not yet saved) values. */
  current: { onboardingComplete: boolean; settings: Settings };
}

/**
 * Per-key merge of another window's save: only keys that changed in `incoming`
 * (vs. our last saved file) are taken, so a pending local edit to a different
 * key is never reverted by whole-file last-writer-wins.
 */
export function mergeForeignSave(
  incoming: SettingsFile,
  lastSaved: SettingsFile | null,
  current: Options['current'],
): Options['current'] {
  const settings = { ...current.settings };
  for (const key of Object.keys(incoming.settings) as (keyof Settings)[]) {
    if (!lastSaved || JSON.stringify(incoming.settings[key]) !== JSON.stringify(lastSaved.settings[key])) {
      (settings as Record<string, unknown>)[key] = incoming.settings[key];
    }
  }
  const onboardingChanged = !lastSaved || incoming.onboardingComplete !== lastSaved.onboardingComplete;
  return {
    onboardingComplete: onboardingChanged ? incoming.onboardingComplete : current.onboardingComplete,
    settings,
  };
}

/**
 * Re-hydrate when another window saved settings.json (`settings:changed`).
 * Our own saves are filtered out in the bridge by source label. The incoming
 * file becomes "last saved" before the dispatch, so the persist effect only
 * writes again if a local pending edit had to be merged in; bumping the
 * generation drops in-flight save results from before the change.
 */
export function useSettingsSync({ allowRef, enabled, dispatch, lastSavedRef, lastRequestedRef, persistGenRef, current }: Options) {
  const currentRef = useRef(current);
  currentRef.current = current;
  useEffect(() => {
    if (!enabled) return;
    return subscribe(() => listenSettingsChanged(({ contents }) => {
      const parsed = parseSettingsJson(contents);
      if (!parsed.ok) return;
      const merged = mergeForeignSave(parsed.file, lastSavedRef.current, currentRef.current);
      lastSavedRef.current = parsed.file;
      if (lastRequestedRef) lastRequestedRef.current = parsed.file;
      persistGenRef.current += 1;
      if (allowRef && !allowRef.current) {
        allowRef.current = true;
        dispatch({ message: null, type: 'set-settings-error' });
      }
      dispatch({ ...merged, now: Date.now(), type: 'hydrate-settings' });
    }));
  }, [allowRef, dispatch, enabled, lastRequestedRef, lastSavedRef, persistGenRef]);
}
