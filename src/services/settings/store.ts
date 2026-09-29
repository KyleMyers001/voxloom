import type { Settings } from '../../domain/types';
import {
  defaultSettingsFile,
  parseSettingsJson,
  serializeSettingsFile,
  type SettingsFile,
} from './format';
import type { SettingsFileIo } from './io';

export type SettingsLoadResult =
  | { ok: true; file: SettingsFile }
  | { ok: false; error: string; file: SettingsFile };

export interface DurableSettingsStore {
  /**
   * Load durable settings. Missing file → defaults ok.
   * Corrupt / unreadable → defaults + error (caller toasts; must not wipe
   * history.json).
   */
  load(): Promise<SettingsLoadResult>;
  /** Persist full settings snapshot + onboarding-complete flag. */
  save(settings: Settings, onboardingComplete: boolean): Promise<void>;
}

export function createSettingsStore(io: SettingsFileIo): DurableSettingsStore {
  return {
    async load() {
      let raw: string | null;
      try {
        raw = await io.read();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          error: `Failed to read settings store: ${message}`,
          file: defaultSettingsFile(),
          ok: false,
        };
      }
      if (raw === null || raw.trim() === '') {
        return { file: defaultSettingsFile(), ok: true };
      }
      const parsed = parseSettingsJson(raw);
      if (!parsed.ok) {
        return {
          error: parsed.error,
          file: defaultSettingsFile(),
          ok: false,
        };
      }
      return { file: parsed.file, ok: true };
    },
    async save(settings, onboardingComplete) {
      const contents = serializeSettingsFile(settings, onboardingComplete);
      await io.write(contents);
    },
  };
}
