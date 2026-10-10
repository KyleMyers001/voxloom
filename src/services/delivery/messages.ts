/**
 * Truthful Inserted / Copied / Failed messaging — only with completion evidence.
 */

import type { DeliveryStatus, TargetKind } from './types';

export function statusLabel(status: DeliveryStatus): 'Inserted' | 'Copied' | 'Failed' {
  if (status === 'inserted') return 'Inserted';
  if (status === 'copied') return 'Copied';
  return 'Failed';
}

export function reasonForKind(kind: TargetKind, detail?: string | null): string {
  switch (kind) {
    case 'secure':
      return 'secure field — insert skipped';
    case 'closed':
      return 'original app closed';
    case 'changed':
      return 'target changed';
    case 'unsupported':
      return detail ?? 'unsupported field';
    case 'unavailable':
      return detail ?? 'target unavailable';
    case 'insertable':
      return detail ?? 'insertable';
    default: {
      const _exhaustive: never = kind;
      return String(_exhaustive);
    }
  }
}

/** Build a single toast line: "Inserted" | "Copied — …" | "Failed — …". */
export function deliveryMessage(
  status: DeliveryStatus,
  detail: string | null,
): string {
  const label = statusLabel(status);
  if (!detail) return label;
  return `${label} — ${detail}`;
}

export function restoreSkippedSuffix(reason: string | null): string {
  if (!reason) return '';
  return ` (clipboard not restored: ${reason})`;
}

export const MANUAL_RECOVERY_HINT =
  'Text is available for manual Copy from the last transcript below'
  + ' (History Copy works when retention is on).';
