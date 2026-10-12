import { isTauri } from '@tauri-apps/api/core';

import { createMemorySettingsIo } from './io';
import {
  createSettingsStore,
  type DurableSettingsStore,
} from './store';
import { createTauriSettingsIo } from './tauriIo';

export type { SettingsFileIo } from './io';
export type { SettingsLoadResult, DurableSettingsStore } from './store';
export type { SettingsFile, ParseSettingsResult } from './format';
export {
  SETTINGS_FILE_VERSION,
  coerceSettings,
  defaultSettingsFile,
  parseSettingsJson,
  serializeSettingsFile,
} from './format';
export { SETTINGS_UPGRADING_MESSAGE, createSettingsStore } from './store';
export { createMemorySettingsIo } from './io';
export {
  createTauriSettingsIo,
  isSettingsPersistenceAvailable,
} from './tauriIo';

/**
 * Default store: Tauri app-data when running in the shell; otherwise an
 * isolated in-memory IO (browser / unit tests — no durable disk).
 */
/**
 * Settings-window store (BUS-42): reads/writes settings.json but never backs
 * it up (store_backup is granted to main only). An older-version or corrupt
 * file is therefore loaded write-blocked with a calm "main is upgrading it"
 * notice; main rewrites it as v1 at boot and its settings:changed broadcast
 * re-enables writes here.
 */
export function createSettingsWindowSettingsStore(): {
  enabled: boolean;
  store: DurableSettingsStore;
} {
  const base = createDefaultSettingsStore();
  if (!base.enabled) return base;
  const io = createTauriSettingsIo();
  return {
    enabled: true,
    store: createSettingsStore({ read: io.read, write: io.write }),
  };
}

export function createDefaultSettingsStore(): {
  enabled: boolean;
  store: DurableSettingsStore;
} {
  if (isTauri()) {
    return {
      enabled: true,
      store: createSettingsStore(createTauriSettingsIo()),
    };
  }
  return {
    enabled: false,
    store: createSettingsStore(createMemorySettingsIo()),
  };
}
