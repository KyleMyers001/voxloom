import type { Settings } from '../../domain/types';
import {
  SETTINGS_FILE_VERSION,
  defaultSettingsFile,
  parseSettingsJson,
  serializeSettingsFile,
  unknownSettingsKeys,
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

/** Shown by a window that may not back up (Settings) instead of an error. */
export const SETTINGS_UPGRADING_MESSAGE =
  'Settings are being updated by the main Voxloom window. Your changes will save once it finishes.';

function fileVersion(raw: string): unknown {
  try {
    return (JSON.parse(raw) as { version?: unknown }).version;
  } catch {
    return undefined;
  }
}

/**
 * Durable settings.json store.
 *
 * Each window (main, Settings) has its own store instance and therefore its
 * own copy of the unknown settings keys, taken from its own last load(); a
 * window does not pick up unknown keys changed on disk by another build
 * until it loads again.
 */
export function createSettingsStore(io: SettingsFileIo): DurableSettingsStore {
  // Unknown `settings` keys from the last successful load, carried through
  // every save so they are never dropped (BUS-42).
  let extras: Record<string, unknown> = {};
  return {
    async load() {
      // Never carry keys from an earlier load into this one.
      extras = {};
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
      if (parsed.ok) extras = unknownSettingsKeys(raw);
      if (!parsed.ok) {
        const backup = await runBackup(io.backup);
        // Future / unknown version from another build: never replace it.
        // Only truly corrupt JSON may be replaced, and only after a backup.
        const unknownVersion = hasUnknownVersion(raw, [SETTINGS_FILE_VERSION, 2]);
        return {
          error: !io.backup && !unknownVersion
            ? SETTINGS_UPGRADING_MESSAGE
            : `${parsed.error}${describeBackup(backup)}`,
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
            error: io.backup
              ? `Settings file needs migration${describeBackup(backup)}`
              : SETTINGS_UPGRADING_MESSAGE,
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
      const contents = serializeSettingsFile(settings, onboardingComplete, extras);
      await io.write(contents);
    },
  };
}
