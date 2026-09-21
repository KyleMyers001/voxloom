export type { SttEngine, SttModelStore } from "./contracts";
export { copyTranscript, copyTranscriptToClipboard } from "./copySink";
export {
  dogfoodTranscribeAndCopy,
  type CaptureAudioMeta,
  type DogfoodResult,
  type DogfoodTranscribeOptions,
} from "./dogfoodPath";
export { createSttEngine, createSttModelStore } from "./factory";
export { audioHandleFromCapture } from "./fromCapture";
export {
  createMockSttEngine,
  createMockSttModelStore,
  MOCK_TRANSCRIPT_TEXT,
} from "./mockStt";
export type { MockSttOptions } from "./mockStt";
export {
  catalogModelIds,
  isKnownSttModelId,
  resolveTranscriptionModelId,
} from "./resolveModelId";
export { useSttModels } from "./useSttModels";
export type { UseSttModelsOptions, UseSttModelsResult } from "./useSttModels";
export {
  createWhisperSttEngine,
  createWhisperSttModelStore,
  isWhisperNativeAvailable,
} from "./whisperAdapter";
export type { WhisperEngineOptions } from "./whisperAdapter";
export {
  DEFAULT_STT_MODEL_ID,
  STT_MODEL_CATALOG,
  SttError,
  type AudioBufferHandle,
  type SttDownloadProgress,
  type SttErrorCode,
  type SttModelInfo,
  type SttModelStatus,
  type Transcript,
} from "./types";

export { useDogfoodCapture } from "./useDogfoodCapture";
export type {
  DogfoodPhase,
  UseDogfoodCaptureOptions,
  UseDogfoodCaptureResult,
} from "./useDogfoodCapture";

