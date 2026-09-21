import type {
  DictationRecord,
  OnboardingState,
  Screen,
  Settings,
  SettingUpdate,
} from "../domain/types";

export type SettingAction = SettingUpdate & { type: "set-setting" };

export type AppAction =
  | { type: "append-record"; record: DictationRecord }
  | { runId: number; type: "cancel-dictation" }
  | { type: "complete-dictation"; now: number; runId: number }
  | { type: "delete-record"; id: string }
  | { type: "delete-word"; word: string }
  | { type: "expire-recovery"; now: number }
  | { type: "fail-dictation"; now: number; runId: number }
  | { type: "hydrate-records"; records: DictationRecord[] }
  | { type: "hydrate-words"; words: string[] }
  | {
      onboardingComplete: boolean;
      settings: Settings;
      type: "hydrate-settings";
    }
  | {
      completion: "automatic" | "held";
      runId: number;
      type: "process-dictation";
    }
  | {
      /** When true, keep durable dictionary words on reset. */
      persistDictionary?: boolean;
      /** When true (Tauri durable history), do not reseed fixture rows. */
      persistHistory?: boolean;
      /** When true, keep durable settings / onboarding-complete on reset. */
      persistSettings?: boolean;
      type: "reset";
      now: number;
      /** Explicit confirm only — clears durable records (persists empty). */
      wipeHistory?: boolean;
    }
  | { type: "reopen-onboarding" }
  | { type: "retry"; id: string; now: number }
  | { type: "scenario-empty" }
  | { type: "set-clipboard-failure"; value: boolean }
  | { type: "set-dictionary-error"; message: string | null }
  | { type: "set-history-error"; message: string | null }
  | { type: "set-settings-error"; message: string | null }
  | { type: "set-onboarding"; value: OnboardingState }
  | { changes: Partial<OnboardingState>; type: "update-onboarding" }
  | { type: "set-screen"; screen: Screen }
  | SettingAction
  | { type: "set-waveform"; value: "silent" | "speaking" }
  | { editing?: string; type: "save-word"; word: string }
  | { type: "start-dictation" };
