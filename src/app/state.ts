import { createRecords, initialOnboarding, initialSettings } from
  "../domain/fixtures";
import { dictationReducer } from "../domain/dictationMachine";
import {
  canRetry,
  createFailedRecord,
  createSuccessfulRecord,
} from "../domain/records";
import type {
  DictationRecord,
  DictationState,
  OnboardingState,
  Screen,
  Settings,
} from "../domain/types";

export interface AppState {
  clipboardFailure: boolean;
  dictation: DictationState;
  nextRunId: number;
  onboarding: OnboardingState;
  records: DictationRecord[];
  screen: Screen;
  settings: Settings;
  words: string[];
}

export type AppAction =
  | { type: "cancel-dictation" }
  | { type: "complete-dictation"; now: number; runId: number }
  | { type: "delete-record"; id: string }
  | { type: "delete-word"; word: string }
  | { type: "expire-recovery"; now: number }
  | { type: "fail-dictation"; now: number; runId: number }
  | { type: "process-dictation"; runId: number }
  | { type: "reset"; now: number }
  | { type: "retry"; id: string; now: number }
  | { type: "scenario-empty" }
  | { type: "set-clipboard-failure"; value: boolean }
  | { type: "set-onboarding"; value: OnboardingState }
  | { type: "set-screen"; screen: Screen }
  | {
      key: keyof Settings;
      type: "set-setting";
      value: Settings[keyof Settings];
    }
  | { type: "set-waveform"; value: "silent" | "speaking" }
  | { editing?: string; type: "save-word"; word: string }
  | { type: "start-dictation" };

export function createInitialState(now: number): AppState {
  return {
    clipboardFailure: false,
    dictation: { kind: "ready" },
    nextRunId: 1,
    onboarding: { ...initialOnboarding },
    records: createRecords(now),
    screen: "home",
    settings: { ...initialSettings },
    words: ["JSON", "Postgres", "TanStack Query", "TypeScript"],
  };
}

export function appReducer(state: AppState, action: AppAction): AppState {
  if (action.type === "reset") return createInitialState(action.now);
  if (action.type === "set-screen") return { ...state, screen: action.screen };
  if (action.type === "set-setting") {
    return {
      ...state,
      settings: { ...state.settings, [action.key]: action.value },
    };
  }
  if (action.type === "set-onboarding") {
    return { ...state, onboarding: action.value };
  }
  if (action.type === "set-clipboard-failure") {
    return { ...state, clipboardFailure: action.value };
  }
  if (action.type === "scenario-empty") {
    return { ...state, records: [], words: [] };
  }
  if (action.type === "expire-recovery") {
    return {
      ...state,
      records: state.records.map((record) => record.status === "failed"
        ? { ...record, recoveryExpiresAt: action.now - 1 }
        : record),
    };
  }
  if (action.type === "save-word") {
    const remaining = action.editing
      ? state.words.filter((word) => word !== action.editing)
      : state.words;
    return { ...state, words: [...remaining, action.word].sort() };
  }
  if (action.type === "delete-word") {
    return {
      ...state,
      words: state.words.filter((word) => word !== action.word),
    };
  }
  if (action.type === "delete-record") {
    return {
      ...state,
      records: state.records.filter((record) => record.id !== action.id),
    };
  }
  if (action.type === "start-dictation") {
    return {
      ...state,
      dictation: dictationReducer(state.dictation, {
        runId: state.nextRunId,
        type: "start",
      }),
      nextRunId: state.nextRunId + 1,
    };
  }
  if (action.type === "set-waveform") {
    return {
      ...state,
      dictation: dictationReducer(state.dictation, {
        type: "speech",
        waveform: action.value,
      }),
    };
  }
  if (action.type === "process-dictation") {
    return {
      ...state,
      dictation: dictationReducer(state.dictation, {
        runId: action.runId,
        type: "process",
      }),
    };
  }
  if (action.type === "cancel-dictation") {
    return {
      ...state,
      dictation: dictationReducer(state.dictation, { type: "cancel" }),
    };
  }
  if (action.type === "complete-dictation") {
    const record = createSuccessfulRecord({
      id: `record-${state.nextRunId + 10}`,
      now: action.now,
      style: state.settings.style,
    });
    const dictation = dictationReducer(state.dictation, {
      recordId: record.id,
      runId: action.runId,
      type: "complete",
    });
    if (dictation === state.dictation) return state;
    return { ...state, dictation, records: [record, ...state.records] };
  }
  if (action.type === "fail-dictation") {
    const record = createFailedRecord({
      id: `failed-${state.nextRunId + 10}`,
      now: action.now,
      style: state.settings.style,
    });
    const dictation = dictationReducer(state.dictation, {
      recordId: record.id,
      runId: action.runId,
      type: "fail",
    });
    if (dictation === state.dictation) return state;
    return { ...state, dictation, records: [record, ...state.records] };
  }
  if (action.type === "retry") {
    const record = state.records.find(({ id }) => id === action.id);
    if (!record || !canRetry(record, action.now)) return state;
    return {
      ...state,
      dictation: { kind: "processing", runId: state.nextRunId },
      nextRunId: state.nextRunId + 1,
      screen: "home",
    };
  }
  return state;
}
