import { isTauri } from "@tauri-apps/api/core";

import { createHistoryStore, type HistoryStore } from "./store";
import { createMemoryHistoryIo } from "./io";
import { createTauriHistoryIo } from "./tauriIo";

export type { HistoryFileIo } from "./io";
export type { HistoryLoadResult, HistoryStore } from "./store";
export type { TranscriptRetention } from "./format";
export {
  HISTORY_FILE_VERSION,
  RETENTION_30_DAYS_MS,
  applyTranscriptRetention,
  parseHistoryJson,
  serializeHistoryFile,
} from "./format";
export { createHistoryStore } from "./store";
export { createMemoryHistoryIo } from "./io";
export { createTauriHistoryIo, isHistoryPersistenceAvailable } from "./tauriIo";

/**
 * Default store: Tauri app-data when running in the shell; otherwise an
 * isolated in-memory IO (browser / unit tests — no durable disk).
 */
export function createDefaultHistoryStore(): {
  enabled: boolean;
  store: HistoryStore;
} {
  if (isTauri()) {
    return { enabled: true, store: createHistoryStore(createTauriHistoryIo()) };
  }
  return {
    enabled: false,
    store: createHistoryStore(createMemoryHistoryIo()),
  };
}
