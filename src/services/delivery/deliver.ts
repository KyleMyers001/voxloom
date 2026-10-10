/**
 * Orchestrate insert-preferring delivery with truthful Copy fallback + restore.
 * ADR: docs/decisions/native-shortcut-cancel-focus.md §§4–6.
 */

import {
  deliveryMessage,
  MANUAL_RECOVERY_HINT,
  reasonForKind,
  restoreSkippedSuffix,
} from './messages';
import {
  planDelivery,
  shouldRestoreClipboard,
  unavailableSnapshot,
} from './policy';
import type {
  DeliverOptions,
  DeliveryOutcome,
  InsertReport,
  TargetSnapshot,
} from './types';


async function readClipboardText(
  platform: DeliverOptions['platform'],
): Promise<string | null> {
  try {
    const snap = await platform.clipboardRead();
    return snap.ok ? snap.text : null;
  } catch {
    return null;
  }
}

function failOutcome(
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
 * Deliver transcript into the intended target, or Copy / Fail honestly.
 * Never inserts into a wrong / secure / changed app. Never synthesizes Enter.
 */
export async function deliverTranscript(
  options: DeliverOptions,
): Promise<DeliveryOutcome> {
  const text = options.text;
  const now = options.now ?? Date.now;
  const platform = options.platform;

  // Nothing to deliver: never insert, and never overwrite the clipboard.
  if (text.trim() === '') {
    return {
      clipboardRestored: false,
      detail: 'empty transcript',
      message: deliveryMessage('failed', 'nothing to insert (empty transcript)'),
      restoreSkippedReason: null,
      status: 'failed',
      text,
    };
  }

  const intended: TargetSnapshot = options.intended
    ?? unavailableSnapshot(now(), 'no intended target snapshot at invocation');

  let validated: TargetSnapshot;
  try {
    validated = await platform.validateTarget(intended);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    validated = {
      ...intended,
      insertable: false,
      kind: 'unavailable',
      reason: `validate failed: ${detail}`,
    };
  }

  const plan = planDelivery(validated, options.clipboardFallback);

  if (plan.action === 'insert') {
    let report: InsertReport | void;
    try {
      report = await platform.insertText(text, plan.target);
    } catch (error: unknown) {
      const insertFail = error instanceof Error
        ? error.message
        : String(error);
      // Insert API failed after a valid-looking target → Copy + toast if enabled.
      if (!options.clipboardFallback) {
        return failOutcome(text, `insert failed: ${insertFail}`);
      }
      return copyFallback(platform, text, `insert failed: ${insertFail}`);
    }
    if (report?.unverified) {
      return mayHaveInserted(platform, text, options.clipboardFallback, report);
    }
    return {
      clipboardRestored: false,
      detail: report?.typed ? 'typed' : null,
      message: deliveryMessage('inserted', null),
      restoreSkippedReason: null,
      status: 'inserted',
      text,
    };
  }

  if (plan.action === 'copy') {
    return copyFallback(platform, text, plan.reason);
  }

  return failOutcome(text, plan.reason);
}

/**
 * Native write happened but could not be proven complete: the text may already
 * be (partly) in the field. Never claim Inserted, never imply nothing happened
 * — including when the Copy fallback itself fails or is disabled.
 */
async function mayHaveInserted(
  platform: DeliverOptions['platform'],
  text: string,
  clipboardFallback: boolean,
  report: InsertReport,
): Promise<DeliveryOutcome> {
  const detail = `unverified insert: ${report.detail ?? 'read-back failed'}`;
  if (!clipboardFallback) {
    const failed = failOutcome(text, detail);
    return { ...failed, message: `May have been inserted — ${failed.message}` };
  }
  const copied = await copyFallback(platform, text, detail);
  if (copied.status === 'copied') {
    return { ...copied, message: 'May have been inserted — also copied' };
  }
  return { ...copied, message: `May have been inserted — ${copied.message}` };
}

/**
 * Copy fallback: leave transcript on clipboard (intentional — not a temp paste).
 * No restore of prior clipboard on the Copy-as-delivery path (ADR: user needs
 * the transcript). Restore applies only to temporary paste-during-insert,
 * which lives inside the platform insertText implementation when needed.
 */
async function copyFallback(
  platform: DeliverOptions['platform'],
  text: string,
  reason: string,
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
    message: deliveryMessage('copied', reason),
    restoreSkippedReason: null,
    status: 'copied',
    text,
  };
}

/**
 * Temporary paste-path clipboard restore helper for adapters that paste.
 * Exported for unit tests and macOS paste fallback.
 */
export async function restoreAfterPaste(input: {
  platform: DeliverOptions['platform'];
  priorOk: boolean;
  priorText: string | null;
  ourText: string;
  writeCompleted: boolean;
}): Promise<{ restored: boolean; skipReason: string | null }> {
  const currentAfterOurWrite = await readClipboardText(input.platform);

  const decision = shouldRestoreClipboard({
    currentAfterOurWrite,
    ourText: input.ourText,
    ourWriteCompleted: input.writeCompleted,
    priorText: input.priorText,
    snapshotOk: input.priorOk,
  });

  if (!decision.restore || input.priorText === null) {
    return { restored: false, skipReason: decision.skipReason };
  }

  try {
    await input.platform.clipboardRestore(input.priorText);
    return { restored: true, skipReason: null };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { restored: false, skipReason: `restore failed: ${detail}` };
  }
}

/** Append restore honesty to an insert-via-paste outcome message. */
export function withRestoreHonesty(
  outcome: DeliveryOutcome,
  restored: boolean,
  skipReason: string | null,
): DeliveryOutcome {
  if (outcome.status !== 'inserted') return outcome;
  if (restored) {
    return { ...outcome, clipboardRestored: true };
  }
  if (!skipReason) return outcome;
  return {
    ...outcome,
    clipboardRestored: false,
    message: outcome.message + restoreSkippedSuffix(skipReason),
    restoreSkippedReason: skipReason,
  };
}

export { reasonForKind };
