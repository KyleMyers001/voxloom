import type { DictationRecord, HistoryStatus, WritingStyle } from
  '../../domain/types';

/** On-disk schema version for `history.json`. */
export const HISTORY_FILE_VERSION = 2 as const;

export type TranscriptRetention = '30-days' | 'forever' | 'off';

export interface HistoryFile {
  records: DictationRecord[];
  version: typeof HISTORY_FILE_VERSION;
}

const STATUSES: readonly HistoryStatus[] = ['copied', 'failed', 'inserted'];
const STYLES: readonly WritingStyle[] = ['casual', 'formal', 'very-casual'];

const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_30_DAYS_MS = 30 * DAY_MS;

export type ParseHistoryResult =
  | { ok: true; file: HistoryFile }
  | { ok: false; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function legacyCleanup(): NonNullable<DictationRecord['cleanup']> {
  return {
    dictionaryDigest: null,
    dictionaryVersion: 1,
    modelDigest: null,
    modelId: null,
    promptVersion: 'legacy-v1',
    reason: 'migrated from history v1',
    status: 'skipped',
  };
}

function unavailableCleanup(): NonNullable<DictationRecord['cleanup']> {
  return {
    dictionaryDigest: null,
    dictionaryVersion: 1,
    modelDigest: null,
    modelId: null,
    promptVersion: 'unavailable',
    reason: 'cleanup metadata could not be understood',
    status: 'unavailable',
  };
}

function parseCleanup(value: unknown): DictationRecord['cleanup'] | null {
  if (!isObject(value)) return null;
  const {
    dictionaryDigest,
    dictionaryVersion,
    modelDigest,
    modelId,
    promptVersion,
    reason,
    status,
  } = value;
  if (
    !(dictionaryDigest === null || typeof dictionaryDigest === 'string')
    || dictionaryVersion !== 1
    || !(modelDigest === null || typeof modelDigest === 'string')
    || !(modelId === null || typeof modelId === 'string')
    || typeof promptVersion !== 'string'
    || !(reason === null || typeof reason === 'string')
    || (modelId === null && modelDigest !== null)
    || typeof status !== 'string'
    || !['cleaned', 'fallback', 'skipped', 'unavailable'].includes(status)
  ) return null;
  return {
    dictionaryDigest,
    dictionaryVersion,
    modelDigest,
    modelId,
    promptVersion,
    reason,
    status: status as NonNullable<DictationRecord['cleanup']>['status'],
  };
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
  const parsedRawText = legacy ? text : rawText;
  if (typeof parsedRawText !== 'string') return null;
  return {
    cleanup,
    createdAt,
    durationSeconds,
    id,
    model,
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
  if (parsed.version !== 1 && parsed.version !== HISTORY_FILE_VERSION) {
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
