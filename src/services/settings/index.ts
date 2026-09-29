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
export { createSettingsStore } from './store';
export { createMemorySettingsIo } from './io';
export {
  createTauriSettingsIo,
  isSettingsPersistenceAvailable,
} from './tauriIo';

/**
 * Default store: Tauri app-data when running in the shell; otherwise an
 * isolated in-memory IO (browser / unit tests — no durable disk).
 */
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
