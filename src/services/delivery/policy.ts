/**
 * Pure delivery policy (ADR §§4–6). No I/O — adapters inject evidence.
 */

import type { TargetKind, TargetSnapshot } from "./types";

/** May we attempt insert into this validated completion-time target? */
export function mayInsert(validated: TargetSnapshot): boolean {
  return validated.insertable && validated.kind === "insertable";
}

/**
 * Prefer insert; else Copy when fallback enabled; else fail.
 * Does not perform I/O — only classifies the intended action.
 */
export type DeliveryPlan =
  | { action: "insert"; target: TargetSnapshot }
  | { action: "copy"; reason: string; kind: TargetKind }
  | { action: "fail"; reason: string; kind: TargetKind };

export function planDelivery(
  validated: TargetSnapshot,
  clipboardFallback: boolean,
): DeliveryPlan {
  if (mayInsert(validated)) {
    return { action: "insert", target: validated };
  }

  const kind = validated.kind === "insertable" ? "unsupported" : validated.kind;
  const reason = validated.reason
    ?? (kind === "secure"
      ? "secure field — insert skipped"
      : kind === "closed"
      ? "original app closed"
      : kind === "changed"
      ? "target changed"
      : "insert not available");

  if (clipboardFallback) {
    return { action: "copy", reason, kind };
  }
  return { action: "fail", reason, kind };
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
    return { restore: false, skipReason: "no prior clipboard snapshot" };
  }
  if (!input.ourWriteCompleted) {
    return { restore: false, skipReason: "clipboard write did not complete" };
  }
  if (input.currentAfterOurWrite !== input.ourText) {
    return {
      restore: false,
      skipReason: "clipboard changed (possible user copy) — left as-is",
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
    kind: "unavailable",
    reason,
  };
}
