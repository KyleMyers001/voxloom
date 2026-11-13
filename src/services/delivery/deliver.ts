/**
 * Orchestrate insert-preferring delivery with truthful Copy fallback + restore.
 * ADR: docs/decisions/native-shortcut-cancel-focus.md §§4–6.
 */

import {
  deliveryMessage,
  reasonForKind,
  restoreSkippedSuffix,
} from './messages';
import { copyFallback, failOutcome, mayHaveInserted } from './fallback';
import { fieldPastedOutcome, pasteInTerminal } from './paste';
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
import { InsertError } from './types';


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
  const current = () => options.isCurrent?.() ?? true;
  const stale = () => failOutcome(text, 'session cancelled or superseded; delivery skipped');

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

  if (!current()) return stale();

  const intended: TargetSnapshot = options.intended
    ?? unavailableSnapshot(now(), 'no intended target snapshot at transcription completion');

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

  if (!current()) return stale();
  const plan = planDelivery(validated, options.clipboardFallback, intended, options.pasteBinding);

  if (plan.action === 'paste') {
    return pasteInTerminal(options, plan.bound, current, stale);
  }

  if (plan.action === 'insert') {
    let report: InsertReport | void;
    try {
      report = await platform.insertText(text, plan.target, {
        pasteFallback: options.clipboardFallback,
      });
    } catch (error: unknown) {
      const insertFail = error instanceof Error
        ? error.message
        : String(error);
      if (error instanceof InsertError && error.writeStarted) {
        // The write may have landed: never say "Couldn't insert" (mayHaveInserted).
        const report = { detail: `insert error after write began: ${insertFail}`, typed: false, unverified: true };
        if (!current()) return mayHaveInserted(platform, text, false, report);
        return mayHaveInserted(platform, text, options.clipboardFallback, report);
      }
      if (!current()) return stale();
      // Insert API failed after a valid-looking target → Copy + toast if enabled.
      if (!options.clipboardFallback) {
        return failOutcome(text, `insert failed: ${insertFail}`);
      }
      return copyFallback(
        platform,
        text,
        `insert failed: ${insertFail}`,
        plan.target.knownTerminal === true,
      );
    }
    if (report?.terminalDispatch) {
      // Posting is not input-buffer confirmation. Never copy or retry after
      // any Terminal dispatch, even if the session was cancelled in flight.
      const sent = report.terminalDispatch === 'complete' ? 'Text sent' : 'Text partly sent';
      return {
        clipboardRestored: false,
        detail: report.detail,
        message: `${sent} to Terminal — input not verified. Inspect before retrying.`,
        restoreSkippedReason: null,
        status: 'unverified',
        text,
      };
    }
    if (report?.paste) {
      // Native ⌘V fallback: the clipboard was restored on purpose, so never copy.
      return fieldPastedOutcome(text, report, report.paste);
    }
    if (report?.unverified) {
      // An in-flight native write cannot be undone; preserve its uncertainty.
      if (!current()) return mayHaveInserted(platform, text, false, report);
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
    return copyFallback(platform, text, plan.reason, plan.terminal);
  }

  return failOutcome(text, plan.reason);
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
