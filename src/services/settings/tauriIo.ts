import { invoke, isTauri } from "@tauri-apps/api/core";

import type { SettingsFileIo } from "./io";

/**
 * Tauri app-data IO via `settings_load` / `settings_save` commands.
 * Missing file returns null from read (first launch).
 */
export function createTauriSettingsIo(): SettingsFileIo {
  return {
    async read() {
      const raw = await invoke<string | null>("settings_load");
      return raw;
    },
    async write(contents: string) {
      await invoke("settings_save", { contents });
    },
  };
}

export function isSettingsPersistenceAvailable(): boolean {
  return isTauri();
}
