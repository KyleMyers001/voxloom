import { dictationReducer } from '../domain/dictationMachine';
import { initialOnboarding } from '../domain/fixtures';
import {
  canRetry,
  createFailedRecord,
  createSuccessfulRecord,
} from '../domain/records';
import type {
  DictationRecord,
  DictationState,
  OnboardingState,
  Screen,
  Settings,
} from '../domain/types';
import type { AppAction } from './actions';
import { createInitialState } from './initialState';

export { createInitialState } from './initialState';
export type { AppAction, SettingAction } from './actions';

export interface AppState {
  clipboardFailure: boolean;
  dictation: DictationState;
  /** Load/save failure message for durable dictionary; null when healthy. */
  dictionaryError: string | null;
  /** Load/save failure message for durable history; null when healthy. */
  historyError: string | null;
  /** Load/save failure message for durable settings; null when healthy. */
  settingsError: string | null;
  nextRunId: number;
  onboarding: OnboardingState;
  records: DictationRecord[];
  screen: Screen;
  settings: Settings;
  words: string[];
}

export function appReducer(state: AppState, action: AppAction): AppState {
  if (action.type === 'reset') {
    const persistDictionary = action.persistDictionary === true;
    const persistHistory = action.persistHistory === true;
    const persistSettings = action.persistSettings === true;
    const next = createInitialState(action.now, {
      persistDictionary,
      persistHistory,
      persistSettings,
    });
    let result = next;
    if (persistHistory && action.wipeHistory !== true) {
      // Session UI reset only — keep durable rows so history.json is not
      // overwritten with fixture seed data.
      result = { ...result, records: state.records };
    }
    if (persistSettings) {
      // Keep durable settings + onboarding-complete so settings.json is not
      // overwritten with fixture defaults on DEV Reset.
      result = {
        ...result,
        onboarding: {
          ...result.onboarding,
          complete: state.onboarding.complete,
        },
        settings: state.settings,
      };
    }
    if (persistDictionary) {
      // Keep durable dictionary words so dictionary.json is not overwritten
      // with fixture seed data on DEV Reset.
      result = { ...result, words: state.words };
    }
    // wipeHistory + persistHistory → empty records (persist effect saves []).
    // Non-persist → fixture seed via createInitialState (browser / unit).
    return result;
  }
  if (action.type === 'reopen-onboarding') {
    return {
      ...state,
      onboarding: {
        ...initialOnboarding,
        complete: state.onboarding.complete,
        microphoneGranted: state.onboarding.microphoneGranted,
      },
    };
  }
  if (action.type === 'set-screen') return { ...state, screen: action.screen };
  if (action.type === 'set-setting') {
    return {
      ...state,
      settings: { ...state.settings, [action.key]: action.value },
    };
  }
  if (action.type === 'set-onboarding') {
    return { ...state, onboarding: action.value };
  }
  if (action.type === 'update-onboarding') {
    return {
      ...state,
      onboarding: { ...state.onboarding, ...action.changes },
    };
  }
  if (action.type === 'set-clipboard-failure') {
    return { ...state, clipboardFailure: action.value };
  }
  if (action.type === 'scenario-empty') {
    return { ...state, records: [], words: [] };
  }
  if (action.type === 'expire-recovery') {
    return {
      ...state,
      records: state.records.map((record) => record.status === 'failed'
        ? { ...record, recoveryExpiresAt: action.now - 1 }
        : record),
    };
  }
  if (action.type === 'save-word') {
    const remaining = action.editing
      ? state.words.filter((word) => word !== action.editing)
      : state.words;
    return { ...state, words: [...remaining, action.word].sort() };
  }
  if (action.type === 'delete-word') {
    return {
      ...state,
      words: state.words.filter((word) => word !== action.word),
    };
  }
  if (action.type === 'append-record') {
    return {
      ...state,
      historyError: null,
      records: [action.record, ...state.records],
    };
  }
  if (action.type === 'hydrate-records') {
    return {
      ...state,
      historyError: null,
      records: action.records,
    };
  }
  if (action.type === 'set-history-error') {
    if (state.historyError === action.message) return state;
    return { ...state, historyError: action.message };
  }
  if (action.type === 'hydrate-settings') {
    return {
      ...state,
      onboarding: {
        ...state.onboarding,
        complete: action.onboardingComplete,
      },
      settings: action.settings,
      settingsError: null,
    };
  }
  if (action.type === 'set-settings-error') {
    if (state.settingsError === action.message) return state;
    return { ...state, settingsError: action.message };
  }
  if (action.type === 'hydrate-words') {
    return {
      ...state,
      dictionaryError: null,
      words: action.words,
    };
  }
  if (action.type === 'set-dictionary-error') {
    if (state.dictionaryError === action.message) return state;
    return { ...state, dictionaryError: action.message };
  }
  if (action.type === 'delete-record') {
    return {
      ...state,
      records: state.records.filter((record) => record.id !== action.id),
    };
  }
  if (action.type === 'start-dictation') {
    const dictation = dictationReducer(state.dictation, {
      runId: state.nextRunId,
      type: 'start',
    });
    if (dictation === state.dictation) return state;
    return {
      ...state,
      dictation,
      nextRunId: state.nextRunId + 1,
    };
  }
  if (action.type === 'set-waveform') {
    return {
      ...state,
      dictation: dictationReducer(state.dictation, {
        type: 'speech',
        waveform: action.value,
      }),
    };
  }
  if (action.type === 'process-dictation') {
    const dictation = dictationReducer(state.dictation, {
      completion: action.completion,
      runId: action.runId,
      type: 'process',
    });
    return dictation === state.dictation ? state : { ...state, dictation };
  }
  if (action.type === 'cancel-dictation') {
    const dictation = dictationReducer(state.dictation, {
      runId: action.runId,
      type: 'cancel',
    });
    return dictation === state.dictation ? state : { ...state, dictation };
  }
  if (action.type === 'complete-dictation') {
    const sourceId = state.dictation.kind === 'processing'
      ? state.dictation.retrySourceId
      : undefined;
    const record = createSuccessfulRecord({
      id: sourceId ?? `record-${state.nextRunId + 10}`,
      now: action.now,
      style: state.settings.style,
    });
    const dictation = dictationReducer(state.dictation, {
      recordId: record.id,
      runId: action.runId,
      type: 'complete',
    });
    if (dictation === state.dictation) return state;
    const records = sourceId
      ? state.records.map((item) => item.id === sourceId ? record : item)
      : [record, ...state.records];
    return { ...state, dictation, records };
  }
  if (action.type === 'fail-dictation') {
    const sourceId = state.dictation.kind === 'processing'
      ? state.dictation.retrySourceId
      : undefined;
    const record = createFailedRecord({
      id: sourceId ?? `failed-${state.nextRunId + 10}`,
      now: action.now,
      style: state.settings.style,
    });
    const dictation = dictationReducer(state.dictation, {
      recordId: record.id,
      runId: action.runId,
      type: 'fail',
    });
    if (dictation === state.dictation) return state;
    const records = sourceId
      ? state.records.map((item) => item.id === sourceId ? record : item)
      : [record, ...state.records];
    return { ...state, dictation, records };
  }
  if (action.type === 'retry') {
    const record = state.records.find(({ id }) => id === action.id);
    if (!canStartDictation(state.dictation) || !record ||
        !canRetry(record, action.now)) return state;
    return {
      ...state,
      dictation: {
        completion: 'automatic',
        kind: 'processing',
        retrySourceId: record.id,
        runId: state.nextRunId,
      },
      nextRunId: state.nextRunId + 1,
      screen: 'home',
    };
  }
  return state;
}

export function canStartDictation(dictation: DictationState): boolean {
  return dictation.kind !== 'listening' && dictation.kind !== 'processing';
}
