/**
 * Outcomes shared by the insert and paste routes: a failure, a Copy fallback,
 * and "may have been inserted" (a write that could not be proven complete).
 */

import {
  copiedMessage,
  deliveryMessage,
  MANUAL_RECOVERY_HINT,
} from './messages';
import type { DeliverOptions, DeliveryOutcome, InsertReport } from './types';

export function failOutcome(
  text: string,
  detail: string,
  extras?: Partial<DeliveryOutcome>,
): DeliveryOutcome {
  return {
    clipboardRestored: false,
    detail,
    message: deliveryMessage('failed', `${detail}. ${MANUAL_RECOVERY_HINT}`),
    restoreSkippedReason: extras?.restoreSkippedReason ?? null,
    status: 'failed',
    text,
    ...extras,
  };
}


/**
 * Native write happened but could not be proven complete: the text may already
 * be (partly) in the field. Never claim Inserted, never imply nothing happened
 * — including when the Copy fallback itself fails or is disabled.
 */
export async function mayHaveInserted(
  platform: DeliverOptions['platform'],
  text: string,
  clipboardFallback: boolean,
  report: InsertReport,
): Promise<DeliveryOutcome> {
  const detail = `unverified insert: ${report.detail ?? 'read-back failed'}`;
  if (!clipboardFallback) {
    const failed = failOutcome(text, detail);
    return { ...failed, mayHaveInserted: true, message: `May have been inserted — ${failed.message}` };
  }
  const copied = await copyFallback(platform, text, detail);
  if (copied.status === 'copied') {
    return { ...copied, mayHaveInserted: true, message: 'May have been inserted — also copied' };
  }
  return { ...copied, mayHaveInserted: true, message: `May have been inserted — ${copied.message}` };
}

/**
 * Copy fallback: leave transcript on clipboard (intentional — not a temp paste).
 * No restore of prior clipboard on the Copy-as-delivery path (ADR: user needs
 * the transcript). Restore applies only to temporary paste-during-insert,
 * which lives inside the platform insertText implementation when needed.
 */
export async function copyFallback(
  platform: DeliverOptions['platform'],
  text: string,
  reason: string,
  terminal = false,
): Promise<DeliveryOutcome> {
  try {
    await platform.clipboardWrite(text);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return failOutcome(
      text,
      `clipboard unavailable: ${detail}`,
    );
  }

  // Conflict check: confirm our text landed; if not, be honest.
  let conflict = false;
  try {
    const snap = await platform.clipboardRead();
    if (snap.ok && snap.text !== null && snap.text !== text) {
      conflict = true;
    }
  } catch {
    // Read failure: cannot prove conflict; treat write as Copied.
  }

  if (conflict) {
    return {
      clipboardRestored: false,
      detail: reason,
      message: deliveryMessage(
        'failed',
        `clipboard changed after write — ${MANUAL_RECOVERY_HINT}`,
      ),
      restoreSkippedReason: 'clipboard changed after our write',
      status: 'failed',
      text,
    };
  }

  return {
    clipboardRestored: false,
    detail: reason,
    message: copiedMessage(reason, terminal),
    restoreSkippedReason: null,
    status: 'copied',
    text,
  };
}
