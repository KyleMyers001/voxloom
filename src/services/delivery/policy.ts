/**
 * Pure delivery policy (ADR §§4–6). No I/O — adapters inject evidence.
 */

import type { TargetKind, TargetSnapshot } from './types';

/** May we attempt insert into this validated completion-time target? */
export function mayInsert(validated: TargetSnapshot): boolean {
  return validated.insertable && validated.kind === 'insertable';
}

/**
 * Prefer insert; else Copy when fallback enabled; else fail.
 * Does not perform I/O — only classifies the intended action.
 */
export type DeliveryPlan =
  | { action: 'insert'; target: TargetSnapshot }
  | { action: 'paste'; target: TargetSnapshot }
  | { action: 'copy'; reason: string; kind: TargetKind; terminal: boolean }
  | { action: 'fail'; reason: string; kind: TargetKind };

const PASTE_KINDS: readonly TargetKind[] = ['insertable', 'unsupported', 'unavailable'];

/**
 * Same terminal app, by pid and app path, at both ends. The snapshot's own
 * flag only proves what is frontmost now; the binding to where the user
 * started dictating is this comparison. Missing pid or app path fails closed.
 */
function sameTerminal(a: TargetSnapshot, b: TargetSnapshot): boolean {
  return a.pasteTerminal === true && b.pasteTerminal === true
    && PASTE_KINDS.includes(a.kind) && PASTE_KINDS.includes(b.kind)
    && typeof a.appPid === 'number' && a.appPid === b.appPid
    && !!a.pasteApp && a.pasteApp === b.pasteApp;
}

/**
 * Terminals take the paste route only when the app dictation started in
 * (`intended`) and the app in front now (`validated`) are the same flagged
 * terminal. Their AX focus says nothing useful (no field, a read-only area,
 * or one that ignores writes), so this is decided before `mayInsert`. A
 * secure field, a changed target or a closed app never pastes; the native
 * paste re-checks pid, app path, Secure Keyboard Entry and permissions.
 */
export function mayPaste(intended: TargetSnapshot, validated: TargetSnapshot): boolean {
  return sameTerminal(intended, validated);
}

/**
 * `intended` is the recording-start snapshot. Paste needs it, and needs the
 * Clipboard fallback setting on (the route touches the clipboard); without
 * either, a terminal behaves as it did before the paste route existed.
 */
export function planDelivery(
  validated: TargetSnapshot,
  clipboardFallback: boolean,
  intended?: TargetSnapshot,
): DeliveryPlan {
  if (clipboardFallback && intended && mayPaste(intended, validated)) {
    return { action: 'paste', target: validated };
  }
  if (mayInsert(validated)) {
    return { action: 'insert', target: validated };
  }

  const kind = validated.kind === 'insertable' ? 'unsupported' : validated.kind;
  const reason = validated.reason
    ?? (kind === 'secure'
      ? 'secure field — insert skipped'
      : kind === 'closed'
      ? 'original app closed'
      : kind === 'changed'
      ? 'target changed'
      : 'insert not available');

  if (clipboardFallback) {
    // A secure field keeps its own reason, even inside a terminal.
    const terminal = validated.knownTerminal === true && kind !== 'secure';
    return { action: 'copy', reason, kind, terminal };
  }
  return { action: 'fail', reason, kind };
}

/**
 * Restore prior clipboard only when:
 * (a) snapshot succeeded, (b) our write completed, (c) no intervening user copy.
 * `currentAfterOurWrite` should equal `ourText` when safe.
 */
export function shouldRestoreClipboard(input: {
  snapshotOk: boolean;
  priorText: string | null;
  ourWriteCompleted: boolean;
  currentAfterOurWrite: string | null;
  ourText: string;
}): { restore: boolean; skipReason: string | null } {
  if (!input.snapshotOk || input.priorText === null) {
    return { restore: false, skipReason: 'no prior clipboard snapshot' };
  }
  if (!input.ourWriteCompleted) {
    return { restore: false, skipReason: 'clipboard write did not complete' };
  }
  if (input.currentAfterOurWrite !== input.ourText) {
    return {
      restore: false,
      skipReason: 'clipboard changed (possible user copy) — left as-is',
    };
  }
  return { restore: true, skipReason: null };
}

/** Synthetic unavailable snapshot when none was taken at invocation. */
export function unavailableSnapshot(now: number, reason: string): TargetSnapshot {
  return {
    appName: null,
    appPid: null,
    capturedAt: now,
    elementId: null,
    elementRole: null,
    insertable: false,
    kind: 'unavailable',
    reason,
  };
}
