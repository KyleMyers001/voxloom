/**
 * Truthful Inserted / Copied / Failed messaging — only with completion evidence.
 */

import type { DeliveryStatus, TargetKind } from './types';

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
 * Copy result when the frontmost app is a known terminal: nothing was typed
 * or pasted, so say how to finish. Matches the HUD's screen-reader line.
 */
export const TERMINAL_COPY_MESSAGE = 'Copied. Press ⌘V to paste.';

/**
 * A paste (terminal or Messages) went out (⌘V posted) but the user's clipboard was not put
 * back. Only this case speaks; a clean paste is silent (empty message).
 */
export const TERMINAL_PASTE_MESSAGE = 'Paste sent';

/** The Copied line: the terminal hint, else the generic "Copied — reason". */
export function copiedMessage(reason: string, terminal: boolean): string {
  return terminal ? TERMINAL_COPY_MESSAGE : deliveryMessage('copied', reason);
}

/**
 * The native ⌘V fallback (BUS-223) went out but read-back could not prove
 * the text landed. Nothing is copied on top of the restored clipboard.
 */
export const FIELD_PASTE_UNVERIFIED_MESSAGE =
  'May have been inserted — pasted with ⌘V; check the field';

export function restoreSkippedSuffix(reason: string | null): string {
  if (!reason) return '';
  return ` (clipboard not restored: ${reason})`;
}

export const MANUAL_RECOVERY_HINT =
  'Text is available for manual Copy from the last transcript below'
  + ' (History Copy works when retention is on).';
