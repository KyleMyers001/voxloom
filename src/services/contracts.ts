import type { OnboardingState, SettingUpdate } from "../domain/types";

export type ShortcutGesture =
  | "hold-finish"
  | "hold-start"
  | "latch-finish"
  | "latch-start";

export interface DictationLifecycle {
  cancel(runId: number): void;
  complete(runId: number): void;
  fail(runId: number): void;
  finish(runId: number): void;
  holdProcessing(runId: number): void;
  retry(recordId: string): void;
  speech(waveform: "silent" | "speaking"): void;
  start(): void;
}

export interface DictionaryCrud {
  delete(word: string): void;
  save(word: string, editing?: string): void;
}

export interface HistoryDeletion {
  delete(recordId: string): void;
}

export interface SettingsStore {
  update(change: SettingUpdate): void;
}

export interface SetupLifecycle {
  replace(value: OnboardingState): void;
  reopen(): void;
  update(changes: Partial<OnboardingState>): void;
}

export interface ShortcutController {
  dispose(): void;
}

export interface Scheduler {
  clear(timer: number): void;
  set(callback: () => void, delay: number): number;
}
