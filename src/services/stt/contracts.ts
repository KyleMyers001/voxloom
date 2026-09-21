/// STT adapter contracts — BUS-10 scaffold.
/// Keep free of UI and Tauri specifics. Real whisper.cpp is deferred.

import type {
  AudioBufferHandle,
  SttDownloadProgress,
  SttModelInfo,
  Transcript,
} from "./types";

/**
 * Local model inventory and explicit download/cancel.
 *
 * **No silent download:** `download` and `cancel` must only run after an
 * explicit user action (same bar as ADR local-stt-whisper: no silent
 * fetches or uploads). Callers must not invoke `download` from idle
 * lifecycle, app start, or background timers.
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
 */
export interface SttEngine {
  transcribe(audio: AudioBufferHandle): Promise<Transcript>;
}
