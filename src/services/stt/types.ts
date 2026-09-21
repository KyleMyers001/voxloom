/// STT adapter types — BUS-10 scaffold.
/// Free of UI and Tauri specifics. No PCM bytes cross the engine contract
/// beyond an opaque AudioBufferHandle (real whisper wiring is deferred).

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
  | "available"
  | "missing"
  | "downloading"
  | "failed";

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
  | "cancelled"
  | "download-failed"
  | "model-missing"
  | "transcribe-failed"
  | "unsupported-audio";

export class SttError extends Error {
  readonly code: SttErrorCode;

  constructor(code: SttErrorCode, message: string) {
    super(message);
    this.name = "SttError";
    this.code = code;
  }
}
