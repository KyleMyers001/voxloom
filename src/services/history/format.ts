import type { DictationRecord, HistoryStatus, WritingStyle } from
  '../../domain/types';

/** On-disk schema version for `history.json`. */
export const HISTORY_FILE_VERSION = 1 as const;

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
  | { ok: true; file: HistoryFile }
  | { ok: false; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown): DictationRecord | null {
  if (!isObject(value)) return null;
  const {
    createdAt,
    durationSeconds,
    id,
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
  if (!(rawText === undefined || typeof rawText === 'string')) return null;
  return {
    createdAt,
    durationSeconds,
    id,
    model,
    ...(rawText === undefined ? {} : { rawText }),
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
  if (parsed.version !== HISTORY_FILE_VERSION) {
    return {
      error: `Unsupported history file version: ${String(parsed.version)}`,
      ok: false,
    };
  }
  if (!Array.isArray(parsed.records)) {
    return { error: 'History file records must be an array', ok: false };
  }
  const records: DictationRecord[] = [];
  for (const row of parsed.records) {
    const record = parseRecord(row);
    if (record) records.push(record);
  }
  return {
    file: { records, version: HISTORY_FILE_VERSION },
    ok: true,
  };
}

export function serializeHistoryFile(records: DictationRecord[]): string {
  const file: HistoryFile = {
    records,
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
