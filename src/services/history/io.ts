/** Injectable byte store for history.json (Tauri app-data or tests). */
export interface HistoryFileIo {
  /** Read raw file contents; `null` when the file does not exist. */
  read(): Promise<string | null>;
  /** Atomically replace file contents (or clear when writing empty ok). */
  write(contents: string): Promise<void>;
}

/** In-memory IO for unit tests and non-Tauri shells. */
export function createMemoryHistoryIo(
  initial: string | null = null,
): HistoryFileIo & { snapshot: () => string | null } {
  let data = initial;
  return {
    read: async () => data,
    snapshot: () => data,
    write: async (contents) => {
      data = contents;
    },
  };
}
