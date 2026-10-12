import {
  createRecords,
  initialOnboarding,
  initialSettings,
} from '../domain/fixtures';
import type { AppState } from './state';

export interface InitialStateOptions {
  /**
   * When true (Tauri shell with durable dictionary), start with an empty
   * word list so fixture seed data does not flash or overwrite disk
   * before hydrate completes.
   */
  persistDictionary?: boolean;
  /**
   * When true (Tauri shell with durable history), start with an empty
   * record list so fixture seed data does not flash or overwrite disk
   * before hydrate completes.
   */
  persistHistory?: boolean;
  /**
   * When true (Tauri shell with durable settings), start from fixture
   * defaults until hydrate replaces them from settings.json.
   */
  persistSettings?: boolean;
}

export function createInitialState(
  now: number,
  options: InitialStateOptions = {},
): AppState {
  return {
    clipboardFailure: false,
    dictation: { kind: 'ready' },
    dictionaryError: null,
    historyError: null,
    historyErrorSticky: false,
    settingsError: null,
    nextRunId: 1,
    onboarding: { ...initialOnboarding },
    records: options.persistHistory ? [] : createRecords(now),
    screen: 'home',
    settings: { ...initialSettings },
    words: options.persistDictionary
      ? []
      : ['JSON', 'Postgres', 'TanStack Query', 'TypeScript'],
  };
}
