/// STT adapter types — BUS-10 whisper wiring.
/// Free of UI specifics. PCM bytes stay behind an opaque AudioBufferHandle
/// owned by the capture/STT native side; the renderer only sees metadata.

/** Opaque handle to local PCM / audio buffer owned by the capture side. */
export interface AudioBufferHandle {
  readonly durationMs: number;
  readonly id: string;
  readonly sampleRateHz: number;
}

export interface Transcript {
  readonly language?: string;
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
}

export interface SttDownloadProgress {
  readonly bytesReceived: number;
  readonly bytesTotal: number;
  readonly modelId: string;
  readonly ratio: number;
}

export type SttErrorCode =
  | 'cancelled'
  | 'download-failed'
  | 'model-missing'
  | 'transcribe-failed'
  | 'no-speech'
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

/** English-first default catalog (ADR). Tiny is the suggested first download. */
export const DEFAULT_STT_MODEL_ID = 'whisper-tiny.en' as const;

export const STT_MODEL_CATALOG: readonly Omit<SttModelInfo, 'status'>[] = [
  {
    id: 'whisper-tiny.en',
    label: 'Whisper Tiny (English)',
    sizeBytes: 77_700_000,
  },
  {
    id: 'whisper-base.en',
    label: 'Whisper Base (English)',
    sizeBytes: 148_000_000,
  },
] as const;
