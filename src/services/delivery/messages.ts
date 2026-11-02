/**
 * Truthful Inserted / Copied / Failed messaging — only with completion evidence.
 */

import type { DeliveryOutcome, DeliveryStatus, TargetKind } from './types';

export function statusLabel(status: DeliveryStatus): 'Inserted' | 'Copied' | 'Failed' | 'Unverified' {
  if (status === 'unverified') return 'Unverified';
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

/**
 * Copy result when the frontmost app is a known terminal: nothing was typed,
 * so say how to finish. (The HUD's own result line already names ⌘V.)
 */
export const TERMINAL_COPY_MESSAGE = 'Copied, press ⌘V';

/** The Copied line: the terminal hint, else the generic "Copied — reason". */
export function copiedMessage(reason: string, terminal: boolean): string {
  return terminal ? TERMINAL_COPY_MESSAGE : deliveryMessage('copied', reason);
}

export function restoreSkippedSuffix(reason: string | null): string {
  if (!reason) return '';
  return ` (clipboard not restored: ${reason})`;
}

export const MANUAL_RECOVERY_HINT =
  'Text is available for manual Copy from the last transcript below or from History'
  + ' (with transcript retention off, History keeps it until you quit Voxloom).';

/** `detail` of a delivery skipped because its session was no longer current. */
export const STALE_DELIVERY_DETAIL = 'session cancelled or superseded; delivery skipped';

/** Shown when a newer dictation replaced this one before it was delivered. */
export const SUPERSEDED_DELIVERY_MESSAGE =
  'Earlier dictation replaced by a new one. Its text is in History.';

/**
 * Toast for a run that a newer dictation superseded (never a user cancel,
 * which shows nothing): a delivery skipped for that reason says so plainly;
 * any other outcome keeps its own message, but never points at Home's last
 * transcript, which now belongs to the newer dictation.
 */
export function supersededDeliveryMessage(outcome: Pick<DeliveryOutcome, 'detail' | 'message'>): string {
  if (outcome.detail === STALE_DELIVERY_DETAIL) return SUPERSEDED_DELIVERY_MESSAGE;
  return outcome.message.replace(MANUAL_RECOVERY_HINT, 'Its text is in History.');
}
