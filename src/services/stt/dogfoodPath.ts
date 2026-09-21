/// Dogfood STT path: capture audio handle → selected model → Copy sink.
/// No insert / gestures. Model must already be selected (and usually
/// downloaded); this module never starts a download.

import type { ClipboardAdapter } from "../clipboard";
import type { SttEngine } from "./contracts";
import { copyTranscript } from "./copySink";
import { audioHandleFromCapture } from "./fromCapture";
import { createSttEngine } from "./factory";
import { resolveTranscriptionModelId } from "./resolveModelId";
import type { Transcript } from "./types";

export interface CaptureAudioMeta {
  duration_ms: number;
  id: string;
  sample_rate_hz: number;
}

export interface DogfoodTranscribeOptions {
  /** Opaque capture-stopped audio metadata (no PCM over IPC). */
  audio: CaptureAudioMeta;
  clipboard: ClipboardAdapter;
  /**
   * Explicit selected model id (Settings `transcriptionModel`).
   * Resolved via `resolveTranscriptionModelId` — never auto-downloaded.
   */
  modelId: string;
  /** Optional engine factory (tests); defaults to env whisper/mock. */
  createEngine?: (modelId: string) => SttEngine;
}

/**
 * Transcribe a deposited capture buffer with the **selected** model and
 * copy the transcript. Copy sink only — no insert.
 */
export async function dogfoodTranscribeAndCopy(
  options: DogfoodTranscribeOptions,
): Promise<Transcript> {
  const modelId = resolveTranscriptionModelId(options.modelId);
  const engine = (options.createEngine ?? createSttEngine)(modelId);
  const handle = audioHandleFromCapture(options.audio);
  const transcript = await engine.transcribe(handle);
  await copyTranscript(transcript, options.clipboard);
  return transcript;
}
