import type {
  OnboardingState,
  Screen,
  SettingUpdate,
} from "../domain/types";

export type SettingAction = SettingUpdate & { type: "set-setting" };

export type AppAction =
  | { runId: number; type: "cancel-dictation" }
  | { type: "complete-dictation"; now: number; runId: number }
  | { type: "delete-record"; id: string }
  | { type: "delete-word"; word: string }
  | { type: "expire-recovery"; now: number }
  | { type: "fail-dictation"; now: number; runId: number }
  | {
      completion: "automatic" | "held";
      runId: number;
      type: "process-dictation";
    }
  | { type: "reset"; now: number }
  | { type: "reopen-onboarding" }
  | { type: "retry"; id: string; now: number }
  | { type: "scenario-empty" }
  | { type: "set-clipboard-failure"; value: boolean }
  | { type: "set-onboarding"; value: OnboardingState }
  | { changes: Partial<OnboardingState>; type: "update-onboarding" }
  | { type: "set-screen"; screen: Screen }
  | SettingAction
  | { type: "set-waveform"; value: "silent" | "speaking" }
  | { editing?: string; type: "save-word"; word: string }
  | { type: "start-dictation" };
