export type Appearance = 'system' | 'light' | 'dark' | 'sodium-rain';
export type HistoryStatus = 'copied' | 'failed' | 'inserted' | 'unverified';
export type Screen = 'dictionary' | 'history' | 'home' | 'settings';
export type WritingStyle = 'casual' | 'formal' | 'very-casual';

export interface DictationRecord {
  createdAt: number;
  durationSeconds: number;
  id: string;
  /** Transcription model id when known (dogfood / persisted); null for fixtures. */
  model: string | null;
  /**
   * Whisper output before BUS-23 cleanup, only when it differs from `text`.
   * Lives in the same row, so transcript retention applies to it too.
   */
  rawText?: string;
  /**
   * Set with status `unverified` when delivery could not tell whether the
   * text landed (Review #44): `copied` says whether it was also copied.
   */
  mayHaveInserted?: { copied: boolean };
  recoveryExpiresAt: number | null;
  status: HistoryStatus;
  style: WritingStyle;
  text: string;
}

export type DictationState =
  | { kind: 'ready' }
  | { kind: 'listening'; runId: number; waveform: 'silent' | 'speaking' }
  | {
      completion: 'automatic' | 'held';
      kind: 'processing';
      retrySourceId?: string;
      runId: number;
    }
  | { kind: 'success'; recordId: string; runId: number }
  | { kind: 'cancelled'; runId: number }
  | { kind: 'error'; recordId: string; runId: number };

export interface Settings {
  appearance: Appearance;
  audioRetention: 'off' | '24-hours' | '7-days';
  clipboardFallback: boolean;
  language: string;
  languageModel: string;
  microphone: string;
  shortcut: string;
  startAtLogin: boolean;
  style: WritingStyle;
  transcriptRetention: '30-days' | 'forever' | 'off';
  transcriptionModel: string;
}

export type SettingUpdate = {
  [Key in keyof Settings]: {
    key: Key;
    value: Settings[Key];
  }
}[keyof Settings];

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
