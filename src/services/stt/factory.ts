/// Pick mock vs native local STT adapters. Constructing either never downloads.

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

export function createSttEngine(modelId: string, requestId?: string): SttEngine {
  const id = resolveTranscriptionModelId(modelId);
  return isWhisperNativeAvailable()
    ? createWhisperSttEngine({ modelId: id, requestId })
    : createMockSttEngine({ modelId: id });
}
