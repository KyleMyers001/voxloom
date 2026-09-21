/** Injectable byte store for settings.json (Tauri app-data or tests). */
export interface SettingsFileIo {
  /** Read raw file contents; `null` when the file does not exist. */
  read(): Promise<string | null>;
  /** Atomically replace file contents. */
  write(contents: string): Promise<void>;
}

/** In-memory IO for unit tests and non-Tauri shells. */
export function createMemorySettingsIo(
  initial: string | null = null,
): SettingsFileIo & { snapshot: () => string | null } {
  let data = initial;
  return {
    read: async () => data,
    snapshot: () => data,
    write: async (contents) => {
      data = contents;
    },
  };
}
