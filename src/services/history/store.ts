import type { DictationRecord } from '../../domain/types';
import {
  HISTORY_FILE_VERSION,
  applyTranscriptRetention,
  parseHistoryJson,
  serializeHistoryFile,
  type TranscriptRetention,
} from './format';
import type { HistoryFileIo } from './io';
import { describeBackup, runBackup } from '../storeBackup';

export type HistoryLoadResult =
  | { ok: true; records: DictationRecord[]; migratedFrom?: number }
  | { ok: false; error: string };

/** Result of backing up history.json before a prune may run. */
export type HistoryBackupResult = 'saved' | 'no-file' | 'failed';

export interface HistoryStore {
  /**
   * Copy history.json aside (raw bytes, deduped). 'no-file' when there is
   * nothing on disk to protect. Optional for custom stores: absent → failed.
   */
  backup?(): Promise<HistoryBackupResult>;
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
    async backup() {
      if (!io.backup) return 'failed';
      try {
        return (await io.backup()) ? 'saved' : 'no-file';
      } catch {
        return 'failed';
      }
    },
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
      if (raw === null || raw.trim() === '') {
        return { ok: true, records: [] };
      }
      const parsed = parseHistoryJson(raw);
      if (!parsed.ok) {
        // Unreadable / unknown version: preserve a copy. The caller keeps
        // history writes disabled, so the original is never clobbered.
        const backup = await runBackup(io.backup);
        return { error: `${parsed.error}${describeBackup(backup)}`, ok: false };
      }
      if (parsed.sourceVersion !== HISTORY_FILE_VERSION) {
        // Migration: the next save rewrites the file in the current format,
        // so keep the original first. No backup → refuse to migrate.
        const backup = await runBackup(io.backup);
        if (!(backup.ok && backup.path)) {
          return {
            error: `History file version ${parsed.sourceVersion} needs migration${describeBackup(backup)}`,
            ok: false,
          };
        }
        return {
          migratedFrom: parsed.sourceVersion,
          ok: true,
          records: applyTranscriptRetention(parsed.file.records, retention, now),
        };
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
