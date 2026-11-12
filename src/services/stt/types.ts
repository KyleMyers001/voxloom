/// STT adapter types — BUS-10 whisper wiring.
/// Free of UI specifics. PCM bytes stay behind an opaque AudioBufferHandle
/// owned by the capture/STT native side; the renderer only sees metadata.

/** Opaque handle to local PCM / audio buffer owned by the capture side. */
export interface AudioBufferHandle {
  readonly durationMs: number;
  readonly id: string;
  readonly sampleRateHz: number;
}

/**
 * Why native cleanup (BUS-23) reduced a transcript to nothing:
 * near-silent clip (RMS gate), VAD veto, only non-speech tags, or a known
 * silence hallucination on a quiet clip.
 */
export type TranscriptDropReason =
  | 'silent-audio'
  | 'no-speech'
  | 'non-speech-only'
  | 'quiet-hallucination';

export interface Transcript {
  /** Set when BUS-23 cleanup dropped the whole output. */
  readonly dropped?: TranscriptDropReason | null;
  readonly language?: string | null;
  /** Engine output before speech filtering (debugging / History). */
  readonly rawText?: string;
  /** Cleaned text used for insert and Copy. */
  readonly text: string;
}

export type SttModelStatus =
  | 'available'
  | 'missing'
  | 'downloading'
  | 'failed';

export interface SttModelInfo {
  readonly id: string;
  readonly label: string;
  readonly sizeBytes: number;
  readonly status: SttModelStatus;
  /** Omitted by older/native mocks means supported. */
  readonly supported?: boolean;
  readonly unavailableReason?: string;
  /**
   * BUS-76: UI-only. Shown as downloading because a mount started it, but the
   * backend has not registered it yet, so it cannot be canceled.
   */
  readonly pending?: boolean;
  /**
   * Native on-disk check result when `status` is `failed` (BUS-35):
   * `unreadable` = couldn't open, `read-failed` = opened but couldn't read.
   */
  readonly failureReason?: 'damaged' | 'unreadable' | 'read-failed';
}

export interface SttDownloadProgress {
  readonly bytesReceived: number;
  readonly bytesTotal: number;
  readonly modelId: string;
  readonly ratio: number;
}

export type SttErrorCode =
  | 'busy'
  | 'timeout'
  | 'cancelled'
  | 'download-failed'
  | 'download-corrupted'
  | 'model-missing'
  | 'transcribe-failed'
  | 'unsupported-platform'
  | 'unsupported-audio'
  | 'engine-unavailable';

export class SttError extends Error {
  readonly code: SttErrorCode;

  constructor(code: SttErrorCode, message: string) {
    super(message);
    this.name = 'SttError';
    this.code = code;
  }
}

/** BUS-208: new-user English recommendation; explicit saved choices survive. */
export const DEFAULT_STT_MODEL_ID = 'whisper-base.en' as const;

export const STT_MODEL_CATALOG: readonly Omit<SttModelInfo, 'status'>[] = [
  {
    id: 'whisper-tiny.en',
    label: 'Whisper Tiny (English)',
    sizeBytes: 77_700_000,
  },
  {
    id: 'whisper-base.en',
    label: 'Whisper Base (English)',
    sizeBytes: 147_964_211,
  },
  {
    id: 'whisper-large-v3-turbo',
    label: 'Whisper Large v3 Turbo (English)',
    sizeBytes: 1_624_555_275,
  },
  {
    id: 'parakeet-tdt-0.6b-v2',
    label: 'Parakeet v2 (English)',
    // Sum of the pinned native manifest; covered by the catalog parity test.
    sizeBytes: 464_413_247,
  },
  {
    id: 'parakeet-tdt-0.6b-v3',
    label: 'Parakeet v3 (Multilingual)',
    // Sum of the pinned native manifest; covered by the catalog parity test.
    sizeBytes: 483_105_645,
  },
] as const;
