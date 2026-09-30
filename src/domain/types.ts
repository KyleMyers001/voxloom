export type Appearance = 'system' | 'light' | 'dark' | 'sodium-rain';
export type HistoryStatus = 'copied' | 'failed' | 'inserted';
export type Screen = 'dictionary' | 'history' | 'home' | 'settings';
export type WritingStyle = 'casual' | 'formal' | 'very-casual';

export interface CleanupProvenance {
  dictionaryDigest: string | null;
  dictionaryVersion: number;
  modelDigest: string | null;
  modelId: string | null;
  promptVersion: string;
  reason: string | null;
  status: 'cleaned' | 'fallback' | 'skipped' | 'unavailable';
}

export interface DictationRecord {
  cleanup?: CleanupProvenance;
  createdAt: number;
  durationSeconds: number;
  id: string;
  /** Transcription model id when known (dogfood / persisted); null for fixtures. */
  model: string | null;
  recoveryExpiresAt: number | null;
  rawText?: string;
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
  cleanupEnabled: boolean;
  cleanupModelId: string | null;
  clipboardFallback: boolean;
  language: string;
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
