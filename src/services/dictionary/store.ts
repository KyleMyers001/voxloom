import {
  defaultDictionaryFile,
  parseDictionaryJson,
  serializeDictionaryFile,
  type DictionaryFile,
} from "./format";
import type { DictionaryFileIo } from "./io";

export type DictionaryLoadResult =
  | { ok: true; file: DictionaryFile }
  | { ok: false; error: string; file: DictionaryFile };

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
        return {
          error: `Failed to read dictionary store: ${message}`,
          file: defaultDictionaryFile(),
          ok: false,
        };
      }
      if (raw === null || raw.trim() === "") {
        return { file: defaultDictionaryFile(), ok: true };
      }
      const parsed = parseDictionaryJson(raw);
      if (!parsed.ok) {
        return {
          error: parsed.error,
          file: defaultDictionaryFile(),
          ok: false,
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
