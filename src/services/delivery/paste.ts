/**
 * Outcome of a terminal paste (clipboard + ⌘V). A terminal has no field to
 * read back, so a posted paste is recorded `unverified` (History keeps the
 * badge), while the HUD treats it like any other successful insert.
 */

import { restoreSkippedSuffix, TERMINAL_PASTE_MESSAGE } from './messages';
import type { DeliveryOutcome, PasteReport } from './types';

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
