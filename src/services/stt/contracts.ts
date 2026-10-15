/// STT adapter contracts — BUS-10 whisper wiring.
/// Keep free of UI specifics. Implementations may use Tauri IPC behind
/// this boundary; callers stay on mock or whisper adapters.

import type {
  AudioBufferHandle,
  SttDownloadProgress,
  SttModelInfo,
  Transcript,
} from './types';

/**
 * Local model inventory and explicit download/cancel.
 *
 * **No silent download:** `download` and `cancel` must only run after an
 * explicit user action (same bar as ADR local-stt-whisper: no silent
 * fetches or uploads). Callers must not invoke `download` from idle
 * lifecycle, app start, or background timers. Constructing a store or
 * engine must never start a download.
 */
export interface SttModelStore {
  /** Abort an in-flight download started by a prior explicit `download`. */
  cancel(modelId: string): Promise<void>;
  /**
   * Start fetching a model after explicit user intent.
   * Implementations must not auto-start downloads.
   */
  download(
    modelId: string,
    onProgress?: (progress: SttDownloadProgress) => void,
  ): Promise<void>;
  list(): Promise<readonly SttModelInfo[]>;
  status(modelId: string): Promise<SttModelInfo | null>;
}

/**
 * Transcribes a local audio buffer to text.
 * Does not upload audio or transcripts; cloud paths are out of scope.
 *
 * `modelId` is required and explicit: the engine does not
 * silently pick or download a model. Callers select a model first, then
 * construct or bind an engine to that id.
 */
export interface SttEngine {
  /** Selected model for transcription; never empty; never auto-downloaded. */
  readonly modelId: string;
  transcribe(audio: AudioBufferHandle): Promise<Transcript>;
}
