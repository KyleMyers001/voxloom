import type { Settings } from '../../domain/types';
import {
  SETTINGS_FILE_VERSION,
  defaultSettingsFile,
  parseSettingsJson,
  serializeSettingsFile,
  type SettingsFile,
} from './format';
import type { SettingsFileIo } from './io';
import {
  describeBackup,
  hasUnknownVersion,
  runBackup,
} from '../storeBackup';

export type SettingsLoadResult =
  | { ok: true; file: SettingsFile; needsRewrite?: boolean }
  | {
    ok: false;
    error: string;
    file: SettingsFile;
    /**
     * True when the unreadable file could not be backed up: the caller must
     * not write defaults over it (BUS-42).
     */
    writeBlocked: boolean;
  };

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

function fileVersion(raw: string): unknown {
  try {
    return (JSON.parse(raw) as { version?: unknown }).version;
  } catch {
    return undefined;
  }
}

export function createSettingsStore(io: SettingsFileIo): DurableSettingsStore {
  return {
    async load() {
      let raw: string | null;
      try {
        raw = await io.read();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const backup = await runBackup(io.backup);
        return {
          error: `Failed to read settings store: ${message}${describeBackup(backup)}`,
          file: defaultSettingsFile(),
          ok: false,
          // A failed read is not known-corrupt JSON: never replace it.
          writeBlocked: true,
        };
      }
      if (raw === null || raw.trim() === '') {
        return { file: defaultSettingsFile(), ok: true };
      }
      const parsed = parseSettingsJson(raw);
      if (!parsed.ok) {
        const backup = await runBackup(io.backup);
        // Future / unknown version from another build: never replace it.
        // Only truly corrupt JSON may be replaced, and only after a backup.
        const unknownVersion = hasUnknownVersion(raw, [SETTINGS_FILE_VERSION, 2]);
        return {
          error: `${parsed.error}${describeBackup(backup)}`,
          file: defaultSettingsFile(),
          ok: false,
          writeBlocked: unknownVersion || !backup.ok,
        };
      }
      if (fileVersion(raw) !== SETTINGS_FILE_VERSION) {
        // Older/sibling version accepted by the parser: the next save
        // rewrites it, so keep the original first.
        const backup = await runBackup(io.backup);
        if (!backup.ok) {
          return {
            error: `Settings file needs migration${describeBackup(backup)}`,
            file: parsed.file,
            ok: false,
            writeBlocked: true,
          };
        }
        // Main rewrites it as the current version right away (BUS-42).
        return { file: parsed.file, needsRewrite: true, ok: true };
      }
      return { file: parsed.file, ok: true };
    },
    async save(settings, onboardingComplete) {
      const contents = serializeSettingsFile(settings, onboardingComplete);
      await io.write(contents);
    },
  };
}
