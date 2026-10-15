import type { AppAction } from '../../app/state';
import type {
  DictionaryCrud,
  HistoryDeletion,
  SettingsStore,
  SetupLifecycle,
} from '../contracts';

type Dispatch = (action: AppAction) => void;

export function createDictionaryService(dispatch: Dispatch): DictionaryCrud {
  return {
    delete: (word) => dispatch({ type: 'delete-word', word }),
    save: (word, editing) => dispatch({ editing, type: 'save-word', word }),
  };
}

export function createHistoryService(dispatch: Dispatch): HistoryDeletion {
  return {
    delete: (id) => dispatch({ id, type: 'delete-record' }),
  };
}

/** `now` defaults to Date.now for call sites that don't inject a clock. */
export function createSettingsService(
  dispatch: Dispatch,
  now: () => number = Date.now,
): SettingsStore {
  return {
    update: (change) => dispatch({ ...change, now: now(), type: 'set-setting' }),
  };
}

export function createSetupService(dispatch: Dispatch): SetupLifecycle {
  return {
    replace: (value) => dispatch({ type: 'set-onboarding', value }),
    reopen: () => dispatch({ type: 'reopen-onboarding' }),
    update: (changes) => dispatch({
      changes,
      type: 'update-onboarding',
    }),
  };
}
