import { memoryBackups } from '../storeBackup';

/** Injectable byte store for history.json (Tauri app-data or tests). */
export interface HistoryFileIo {
  /** Read raw file contents; `null` when the file does not exist. */
  read(): Promise<string | null>;
  /** Atomically replace file contents (or clear when writing empty ok). */
  write(contents: string): Promise<void>;
  /**
   * Copy the current on-disk file aside before an unreadable / migrated file
   * may be replaced. Resolves to the backup location or `null` (no file).
   * Optional: without it, unreadable files are never overwritten.
   */
  backup?(): Promise<string | null>;
}

/** In-memory IO for unit tests and non-Tauri shells. */
export function createMemoryHistoryIo(
  initial: string | null = null,
): HistoryFileIo & {
  backups: () => string[];
  snapshot: () => string | null;
} {
  let data = initial;
  const mem = memoryBackups(() => data);
  return {
    backup: mem.backup,
    backups: mem.backups,
    read: async () => data,
    snapshot: () => data,
    write: async (contents) => {
      data = contents;
    },
  };
}
