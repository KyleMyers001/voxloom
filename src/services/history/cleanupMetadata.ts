import type { DictationRecord } from '../../domain/types';

/**
 * Cleanup provenance stored on history v2 rows (BUS-16). Unreadable metadata
 * degrades to `unavailable`; it never drops the transcript itself.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function legacyCleanup(): NonNullable<DictationRecord['cleanup']> {
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

export function unavailableCleanup(): NonNullable<DictationRecord['cleanup']> {
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

export function parseCleanup(value: unknown): DictationRecord['cleanup'] | null {
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
