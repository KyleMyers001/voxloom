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
  TargetSnapshot,
} from './types';
import { DeliveryCancelledError } from './types';


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

function assertCanWrite(options: DeliverOptions): void {
  if (options.canWrite?.() === false) {
    throw new DeliveryCancelledError();
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
    writeCommitted: false,
    writeStarted: false,
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
  assertCanWrite(options);

  if (plan.action === 'insert') {
    try {
      await platform.insertText(text, plan.target);
      return {
        clipboardRestored: false,
        detail: null,
        message: deliveryMessage('inserted', null),
        restoreSkippedReason: null,
        status: 'inserted',
        text,
        writeCommitted: true,
        writeStarted: true,
      };
    } catch (error: unknown) {
      const insertFail = error instanceof Error
        ? error.message
        : String(error);
      // Insert API failed after a valid-looking target → Copy + toast if enabled.
      // Cancellation forbids a new write, not evidence of the attempted insert.
      if (!options.clipboardFallback || options.canWrite?.() === false) {
        return failOutcome(text, `insert failed: ${insertFail}`, {
          writeStarted: true,
        });
      }
      return copyFallback(
        platform,
        text,
        `insert failed: ${insertFail}`,
        options,
      );
    }
  }

  if (plan.action === 'copy') {
    return copyFallback(platform, text, plan.reason, options);
  }

  return failOutcome(text, plan.reason);
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
  options: DeliverOptions,
): Promise<DeliveryOutcome> {
  assertCanWrite(options);
  try {
    await platform.clipboardWrite(text);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return failOutcome(
      text,
      `clipboard unavailable: ${detail}`,
      { writeStarted: true },
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
      writeCommitted: true,
      writeStarted: true,
    };
  }

  return {
    clipboardRestored: false,
    detail: reason,
    message: deliveryMessage('copied', reason),
    restoreSkippedReason: null,
    status: 'copied',
    text,
    writeCommitted: true,
    writeStarted: true,
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
