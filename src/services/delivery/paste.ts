/**
 * Outcome of a terminal paste (clipboard + ⌘V). A terminal has no field to
 * read back, so a posted paste is recorded `unverified` (History keeps the
 * badge), while the HUD treats it like any other successful insert.
 */

import { copyFallback, mayHaveInserted } from './fallback';
import { restoreSkippedSuffix, TERMINAL_PASTE_MESSAGE } from './messages';
import { InsertError } from './types';
import type { DeliverOptions, DeliveryOutcome, PasteReport, TargetSnapshot } from './types';

export function pastedOutcome(text: string, report: PasteReport): DeliveryOutcome {
  const skipped = report.clipboardRestored
    ? null
    : report.restoreSkippedReason ?? 'prior clipboard not restored';
  return {
    clipboardRestored: report.clipboardRestored,
    detail: 'Pasted with ⌘V through the clipboard; terminal input not verified',
    message: TERMINAL_PASTE_MESSAGE + restoreSkippedSuffix(skipped),
    restoreSkippedReason: skipped,
    status: 'unverified',
    text,
  };
}

/**
 * Paste into the terminal dictation started in, then let native put the
 * user's clipboard back. `intended` is the recording-start snapshot: native
 * re-checks its pid and app path against the app in front right now. Only
 * reached with Clipboard fallback on (`planDelivery`). A refusal before ⌘V
 * (Secure Keyboard Entry, control characters, the app changed, permissions)
 * copies with the terminal hint. After ⌘V went out nothing is retried or
 * copied: the clipboard was just restored on purpose.
 */
export async function pasteInTerminal(
  options: DeliverOptions,
  intended: TargetSnapshot,
  current: () => boolean,
  stale: () => DeliveryOutcome,
): Promise<DeliveryOutcome> {
  const { platform, text } = options;
  try {
    if (!platform.pasteText) throw new Error('paste unavailable on this platform');
    return pastedOutcome(text, await platform.pasteText(text, intended));
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
