import type { DictationRecord, HistoryStatus, WritingStyle } from
  '../../domain/types';
import {
  legacyCleanup,
  parseCleanup,
  unavailableCleanup,
} from './cleanupMetadata';

/** On-disk schema version for `history.json`. */
export const HISTORY_FILE_VERSION = 2 as const;

/**
 * Accepted schema versions. Version 1 predates cleanup provenance; older
 * files are rewritten only after the store backs up the original (BUS-42).
 */
export const READABLE_HISTORY_VERSIONS: readonly number[] = [1, 2];

export type TranscriptRetention = '30-days' | 'forever' | 'off';

export interface HistoryFile {
  records: DictationRecord[];
  version: typeof HISTORY_FILE_VERSION;
}

const STATUSES: readonly HistoryStatus[] = ['copied', 'failed', 'inserted', 'unverified'];
const STYLES: readonly WritingStyle[] = ['casual', 'formal', 'very-casual'];

const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_30_DAYS_MS = 30 * DAY_MS;

export type ParseHistoryResult =
  | { ok: true; file: HistoryFile; sourceVersion: number }
  | { ok: false; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(
  value: unknown,
  legacy: boolean,
): DictationRecord | null {
  if (!isObject(value)) return null;
  const {
    cleanup: rawCleanup,
    createdAt,
    durationSeconds,
    id,
    mayHaveInserted,
    model,
    rawText,
    recoveryExpiresAt,
    status,
    style,
    text,
  } = value;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds)) {
    return null;
  }
  if (typeof id !== 'string' || !id) return null;
  if (!(model === null || typeof model === 'string')) return null;
  if (!(recoveryExpiresAt === null || typeof recoveryExpiresAt === 'number')) {
    return null;
  }
  if (typeof status !== 'string' || !STATUSES.includes(status as HistoryStatus)) {
    return null;
  }
  if (typeof style !== 'string' || !STYLES.includes(style as WritingStyle)) {
    return null;
  }
  if (typeof text !== 'string') return null;
  // Optional provenance must never erase otherwise valid transcript evidence.
  const cleanup = legacy ? legacyCleanup()
    : parseCleanup(rawCleanup) ?? unavailableCleanup();
  if (!(rawText === undefined || typeof rawText === 'string')) return null;
  const parsedRawText = rawText ?? text;
  const maybe = isObject(mayHaveInserted) && typeof mayHaveInserted.copied === 'boolean'
    ? { mayHaveInserted: { copied: mayHaveInserted.copied } }
    : {};
  return {
    cleanup,
    createdAt,
    durationSeconds,
    id,
    model,
    ...maybe,
    rawText: parsedRawText,
    recoveryExpiresAt,
    status: status as HistoryStatus,
    style: style as WritingStyle,
    text,
  };
}

/**
 * Parse and validate a history JSON document.
 * Corrupt / unknown version → error (caller must not wipe the file).
 * Unknown record rows are skipped; a valid envelope with zero rows is ok.
 */
export function parseHistoryJson(raw: string): ParseHistoryResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { error: 'History file is not valid JSON', ok: false };
  }
  if (!isObject(parsed)) {
    return { error: 'History file root must be an object', ok: false };
  }
  if (
    typeof parsed.version !== 'number'
    || !READABLE_HISTORY_VERSIONS.includes(parsed.version)
  ) {
    return {
      error: `Unsupported history file version: ${String(parsed.version)}`,
      ok: false,
    };
  }
  if (!Array.isArray(parsed.records)) {
    return { error: 'History file records must be an array', ok: false };
  }
  const records: DictationRecord[] = [];
  const legacy = parsed.version === 1;
  for (const row of parsed.records) {
    const record = parseRecord(row, legacy);
    if (record) records.push(record);
  }
  return {
    file: { records, version: HISTORY_FILE_VERSION },
    ok: true,
    sourceVersion: parsed.version,
  };
}

export function serializeHistoryFile(records: DictationRecord[]): string {
  const file: HistoryFile = {
    records: records.map((record) => ({
      ...record,
      cleanup: record.cleanup ?? unavailableCleanup(),
      rawText: record.rawText ?? record.text,
    })),
    version: HISTORY_FILE_VERSION,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * Apply privacy / retention before durable write or after load.
 * `off` → no durable transcripts. `30-days` drops older rows by createdAt.
 */
export function applyTranscriptRetention(
  records: DictationRecord[],
  retention: TranscriptRetention,
  now: number,
): DictationRecord[] {
  if (retention === 'off') return [];
  if (retention === 'forever') return [...records];
  const cutoff = now - RETENTION_30_DAYS_MS;
  return records.filter((record) => record.createdAt >= cutoff);
}
