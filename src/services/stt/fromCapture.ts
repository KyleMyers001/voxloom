import type { AudioBufferHandle } from './types';

/** Capture IPC audio metadata (snake_case) → STT AudioBufferHandle. */
export function audioHandleFromCapture(audio: {
  duration_ms: number;
  id: string;
  sample_rate_hz: number;
}): AudioBufferHandle {
  return {
    durationMs: audio.duration_ms,
    id: audio.id,
    sampleRateHz: audio.sample_rate_hz,
  };
}
