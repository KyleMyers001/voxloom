import { isTauri } from '@tauri-apps/api/core';

import { createMemoryDictionaryIo } from './io';
import {
  createDictionaryStore,
  type DurableDictionaryStore,
} from './store';
import { createTauriDictionaryIo } from './tauriIo';

export type { DictionaryFileIo } from './io';
export type { DictionaryLoadResult, DurableDictionaryStore } from './store';
export type { DictionaryFile, ParseDictionaryResult } from './format';
export {
  DICTIONARY_FILE_VERSION,
  defaultDictionaryFile,
  normalizeWords,
  parseDictionaryJson,
  serializeDictionaryFile,
} from './format';
export { createDictionaryStore } from './store';
export { createMemoryDictionaryIo } from './io';
export {
  createTauriDictionaryIo,
  isDictionaryPersistenceAvailable,
} from './tauriIo';

/**
 * Default store: Tauri app-data when running in the shell; otherwise an
 * isolated in-memory IO (browser / unit tests — no durable disk).
 */
export function createDefaultDictionaryStore(): {
  enabled: boolean;
  store: DurableDictionaryStore;
} {
  if (isTauri()) {
    return {
      enabled: true,
      store: createDictionaryStore(createTauriDictionaryIo()),
    };
  }
  return {
    enabled: false,
    store: createDictionaryStore(createMemoryDictionaryIo()),
  };
}
