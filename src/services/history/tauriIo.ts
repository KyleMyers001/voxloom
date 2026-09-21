import { invoke, isTauri } from "@tauri-apps/api/core";

import type { HistoryFileIo } from "./io";

/**
 * Tauri app-data IO via `history_load` / `history_save` commands.
 * Missing file returns null from read (first launch).
 */
export function createTauriHistoryIo(): HistoryFileIo {
  return {
    async read() {
      const raw = await invoke<string | null>("history_load");
      return raw;
    },
    async write(contents: string) {
      await invoke("history_save", { contents });
    },
  };
}

export function isHistoryPersistenceAvailable(): boolean {
  return isTauri();
}
