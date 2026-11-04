/**
 * Outcome of a paste (clipboard + ⌘V) into a terminal or Messages. Neither
 * has a field to read back, so a posted paste is recorded `unverified`
 * (History keeps the badge). A clean paste is silent: its message is empty, so no status line and
 * no toast, and the HUD shows nothing (as for any successful insert). Only a
 * paste whose clipboard was not restored says so.
 */

import { copyFallback, mayHaveInserted } from './fallback';
import { restoreSkippedSuffix, TERMINAL_PASTE_MESSAGE } from './messages';
import { InsertError } from './types';
import type { DeliverOptions, DeliveryOutcome, PasteBinding, PasteReport } from './types';

export function pastedOutcome(text: string, report: PasteReport): DeliveryOutcome {
  const skipped = report.clipboardRestored
    ? null
    : report.restoreSkippedReason ?? 'prior clipboard not restored';
  return {
    clipboardRestored: report.clipboardRestored,
    detail: 'Pasted with ⌘V through the clipboard; input not verified',
    message: skipped ? TERMINAL_PASTE_MESSAGE + restoreSkippedSuffix(skipped) : '',
    restoreSkippedReason: skipped,
    status: 'unverified',
    text,
  };
}

/**
 * Paste into the terminal (or Messages) that was in front when you started
 * dictating, then let native put the user's clipboard back. `bound` is that app's pid and
 * app path, captured at recording start: native re-checks both against the app
 * in front right now. Only
 * reached with Clipboard fallback on (`planDelivery`). A refusal before ⌘V
 * (Secure Keyboard Entry, control characters, the app changed, permissions)
 * copies with the "Press ⌘V" hint. After ⌘V went out nothing is retried or
 * copied: the clipboard was just restored on purpose.
 */
export async function pasteInTerminal(
  options: DeliverOptions,
  bound: PasteBinding,
  current: () => boolean,
  stale: () => DeliveryOutcome,
): Promise<DeliveryOutcome> {
  const { platform, text } = options;
  try {
    if (!platform.pasteText) throw new Error('paste unavailable on this platform');
    return pastedOutcome(text, await platform.pasteText(text, bound));
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof InsertError && error.writeStarted) {
      // The IPC died after dispatch: ⌘V may have gone out.
      const report = { detail: `paste error after dispatch: ${detail}`, typed: false, unverified: true };
      return mayHaveInserted(platform, text, current(), report);
    }
    if (!current()) return stale();
    return copyFallback(platform, text, `paste skipped: ${detail}`, true);
  }
}
