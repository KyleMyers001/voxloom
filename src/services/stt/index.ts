export type { SttEngine, SttModelStore } from "./contracts";
export { copyTranscript, copyTranscriptToClipboard } from "./copySink";
export { audioHandleFromCapture } from "./fromCapture";
export {
  createMockSttEngine,
  createMockSttModelStore,
  MOCK_TRANSCRIPT_TEXT,
} from "./mockStt";
export type { MockSttOptions } from "./mockStt";
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
