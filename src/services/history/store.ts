import type { DictationRecord } from "../../domain/types";
import {
  applyTranscriptRetention,
  parseHistoryJson,
  serializeHistoryFile,
  type TranscriptRetention,
} from "./format";
import type { HistoryFileIo } from "./io";

export type HistoryLoadResult =
  | { ok: true; records: DictationRecord[] }
  | { ok: false; error: string };

export interface HistoryStore {
  /** Load durable records (honors retention). Missing file → empty ok. */
  load(
    retention: TranscriptRetention,
    now: number,
  ): Promise<HistoryLoadResult>;
  /**
   * Persist records after retention filter.
   * Does not delete a corrupt on-disk file — write only replaces after
   * a successful prior load path or first-launch empty state.
   */
  save(
    records: DictationRecord[],
    retention: TranscriptRetention,
    now: number,
  ): Promise<void>;
}

export function createHistoryStore(io: HistoryFileIo): HistoryStore {
  return {
    async load(retention, now) {
      let raw: string | null;
      try {
        raw = await io.read();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          error: `Failed to read history store: ${message}`,
          ok: false,
        };
      }
      if (raw === null || raw.trim() === "") {
        return { ok: true, records: [] };
      }
      const parsed = parseHistoryJson(raw);
      if (!parsed.ok) {
        return { error: parsed.error, ok: false };
      }
      return {
        ok: true,
        records: applyTranscriptRetention(parsed.file.records, retention, now),
      };
    },
    async save(records, retention, now) {
      const durable = applyTranscriptRetention(records, retention, now);
      const contents = serializeHistoryFile(durable);
      await io.write(contents);
    },
  };
}
