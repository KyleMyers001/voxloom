/// Resolve / validate the Settings-selected STT model id.
/// Legacy mock labels map to the English-first default; unknown ids stay
/// as-given so the engine can surface model-missing honestly.

import {
  DEFAULT_STT_MODEL_ID,
  STT_MODEL_CATALOG,
} from './types';

const LEGACY_SIMULATED_LABELS = new Set([
  'Pine Voice Small · local',
  'Pine Voice Medium · unavailable',
]);

export function isKnownSttModelId(modelId: string): boolean {
  return STT_MODEL_CATALOG.some((entry) => entry.id === modelId);
}

/**
 * Normalize a Settings `transcriptionModel` value to an explicit modelId.
 * Does not download or probe disk — selection only.
 */
export function resolveTranscriptionModelId(
  raw: string | null | undefined,
): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || LEGACY_SIMULATED_LABELS.has(trimmed)) {
    return DEFAULT_STT_MODEL_ID;
  }
  return trimmed;
}

export function catalogModelIds(): readonly string[] {
  return STT_MODEL_CATALOG.map((entry) => entry.id);
}
