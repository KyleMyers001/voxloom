/// Pick mock vs whisper adapters. Constructing either never downloads.

import type { SttEngine, SttModelStore } from './contracts';
import { createMockSttEngine, createMockSttModelStore } from './mockStt';
import {
  createWhisperSttEngine,
  createWhisperSttModelStore,
  isWhisperNativeAvailable,
} from './whisperAdapter';
import { resolveTranscriptionModelId } from './resolveModelId';

export function createSttModelStore(): SttModelStore {
  return isWhisperNativeAvailable()
    ? createWhisperSttModelStore()
    : createMockSttModelStore();
}

export function createSttEngine(modelId: string): SttEngine {
  const id = resolveTranscriptionModelId(modelId);
  return isWhisperNativeAvailable()
    ? createWhisperSttEngine({ modelId: id })
    : createMockSttEngine({ modelId: id });
}
