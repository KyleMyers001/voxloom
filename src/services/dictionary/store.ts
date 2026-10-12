import {
  DICTIONARY_FILE_VERSION,
  defaultDictionaryFile,
  parseDictionaryJson,
  serializeDictionaryFile,
  type DictionaryFile,
} from './format';
import type { DictionaryFileIo } from './io';
import {
  describeBackup,
  hasUnknownVersion,
  runBackup,
} from '../storeBackup';

export type DictionaryLoadResult =
  | { ok: true; file: DictionaryFile }
  | {
    ok: false;
    error: string;
    file: DictionaryFile;
    /**
     * True when the unreadable file could not be backed up: the caller must
     * not write defaults over it (BUS-42).
     */
    writeBlocked: boolean;
  };

export interface DurableDictionaryStore {
  /**
   * Load durable dictionary. Missing file → empty ok.
   * Corrupt / unreadable → empty + error (caller toasts; must not wipe
   * settings.json or history.json).
   */
  load(): Promise<DictionaryLoadResult>;
  /** Persist full words snapshot. */
  save(words: string[]): Promise<void>;
}

export function createDictionaryStore(
  io: DictionaryFileIo,
): DurableDictionaryStore {
  return {
    async load() {
      let raw: string | null;
      try {
        raw = await io.read();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const backup = await runBackup(io.backup);
        return {
          error: `Failed to read dictionary store: ${message}${describeBackup(backup)}`,
          file: defaultDictionaryFile(),
          ok: false,
          // Replace an unreadable file only when its raw bytes were preserved
          // first (store_backup copies bytes, no decoding); otherwise block.
          writeBlocked: !backup.ok,
        };
      }
      if (raw === null || raw.trim() === '') {
        return { file: defaultDictionaryFile(), ok: true };
      }
      const parsed = parseDictionaryJson(raw);
      if (!parsed.ok) {
        const backup = await runBackup(io.backup);
        // Future / unknown version from another build: never replace it.
        // Only truly corrupt JSON may be replaced, and only after a backup.
        const unknownVersion = hasUnknownVersion(raw, [DICTIONARY_FILE_VERSION]);
        return {
          error: `${parsed.error}${describeBackup(backup)}`,
          file: defaultDictionaryFile(),
          ok: false,
          writeBlocked: unknownVersion || !backup.ok,
        };
      }
      return { file: parsed.file, ok: true };
    },
    async save(words) {
      const contents = serializeDictionaryFile(words);
      await io.write(contents);
    },
  };
}
