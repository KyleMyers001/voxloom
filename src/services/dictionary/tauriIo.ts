import { invoke, isTauri } from '@tauri-apps/api/core';

import type { DictionaryFileIo } from './io';

/**
 * Tauri app-data IO via `dictionary_load` / `dictionary_save` commands.
 * Missing file returns null from read (first launch).
 */
export function createTauriDictionaryIo(): DictionaryFileIo {
  return {
    async read() {
      const raw = await invoke<string | null>('dictionary_load');
      return raw;
    },
    async write(contents: string) {
      await invoke('dictionary_save', { contents });
    },
  };
}

export function isDictionaryPersistenceAvailable(): boolean {
  return isTauri();
}
