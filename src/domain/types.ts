export type Appearance = "system" | "light" | "dark" | "sodium-rain";
export type HistoryStatus = "copied" | "failed" | "inserted";
export type Screen = "dictionary" | "history" | "home" | "settings";
export type WritingStyle = "casual" | "formal" | "very-casual";

export interface DictationRecord {
  createdAt: number;
  durationSeconds: number;
  id: string;
  recoveryExpiresAt: number | null;
  status: HistoryStatus;
  style: WritingStyle;
  text: string;
}

export type DictationState =
  | { kind: "ready" }
  | { kind: "listening"; runId: number; waveform: "silent" | "speaking" }
  | {
      completion: "automatic" | "held";
      kind: "processing";
      retrySourceId?: string;
      runId: number;
    }
  | { kind: "success"; recordId: string; runId: number }
  | { kind: "cancelled"; runId: number }
  | { kind: "error"; recordId: string; runId: number };

export interface Settings {
  appearance: Appearance;
  audioRetention: "off" | "24-hours" | "7-days";
  clipboardFallback: boolean;
  language: string;
  languageModel: string;
  microphone: string;
  shortcut: string;
  startAtLogin: boolean;
  style: WritingStyle;
  transcriptRetention: "30-days" | "forever" | "off";
  transcriptionModel: string;
}

export interface OnboardingState {
  complete: boolean;
  holdTested: boolean;
  microphoneGranted: boolean;
  permissionDenied: boolean;
  recognizedText: string;
  shortcutCollision: boolean;
  step: 1 | 2 | 3;
  tapTested: boolean;
}
