import { type Dispatch, type MutableRefObject, useEffect } from 'react';
import { parseSettingsJson, type SettingsFile } from '../services/settings';
import { listenSettingsChanged, subscribe } from '../services/settingsWindow';
import type { AppAction } from './actions';

interface Options {
  enabled: boolean;
  dispatch: Dispatch<AppAction>;
  lastSavedRef: MutableRefObject<SettingsFile | null>;
  persistGenRef: MutableRefObject<number>;
}

/**
 * Re-hydrate when another window saved settings.json (`settings:changed`).
 * The file becomes "last saved" before the dispatch, so the persist effect
 * sees no diff and doesn't write it back; bumping the generation drops any
 * in-flight save result/rollback from before the change.
 */
export function useSettingsSync({ enabled, dispatch, lastSavedRef, persistGenRef }: Options) {
  useEffect(() => {
    if (!enabled) return;
    return subscribe(() => listenSettingsChanged(({ contents }) => {
      const parsed = parseSettingsJson(contents);
      if (!parsed.ok) return;
      lastSavedRef.current = parsed.file;
      persistGenRef.current += 1;
      dispatch({
        onboardingComplete: parsed.file.onboardingComplete,
        settings: parsed.file.settings,
        type: 'hydrate-settings',
      });
    }));
  }, [dispatch, enabled, lastSavedRef, persistGenRef]);
}
