/**
 * BUS-14 delivery types — ADR native-shortcut-cancel-focus §§4–6.
 * Platform adapters produce TargetSnapshot; pure policy decides insert vs Copy.
 */

/** Why a target is or is not insertable. */
export type TargetKind =
  | 'insertable'
  | 'secure'
  | 'unsupported'
  | 'changed'
  | 'closed'
  | 'unavailable';

/**
 * Invocation-time snapshot of the intended insertion target
 * (frontmost app + focused AX element insertability).
 */
export interface TargetSnapshot {
  /** Frontmost application name when known. */
  appName: string | null;
  /** Process id when known (identity check at completion). */
  appPid: number | null;
  /** Opaque element identity for change detection (role + pid + optional id). */
  elementId: string | null;
  /** AX / accessibility role when known. */
  elementRole: string | null;
  /** True only when the element looked safely insertable at snapshot time. */
  insertable: boolean;
  kind: TargetKind;
  /** Human-readable limitation or refusal reason (never empty for refusals). */
  reason: string | null;
  /** Epoch ms when the snapshot was taken. */
  capturedAt: number;
}

/** Evidence-backed delivery result — never claim Inserted/Copied/Failed without it. */
export type DeliveryStatus = 'inserted' | 'copied' | 'failed';

export interface DeliveryOutcome {
  /** Clipboard restore ran successfully after a temporary paste path. */
  clipboardRestored: boolean;
  /** Extra context for logs / history (secure, closed, conflict, …). */
  detail: string | null;
  /** Truthful toast / status line. */
  message: string;
  /** Present when restore was skipped (conflict, no snapshot, write fail). */
  restoreSkippedReason: string | null;
  status: DeliveryStatus;
  /** Always the transcript text for manual recovery (even if history is off). */
  text: string;
  /** An OS insertion or clipboard write was invoked. */
  writeStarted: boolean;
  /** The invoked OS write completed successfully. */
  writeCommitted: boolean;
}

export interface ClipboardSnapshot {
  /** Plain text when read succeeded; null when unavailable / non-text. */
  text: string | null;
  ok: boolean;
}

/**
 * Replaceable platform boundary (macOS first; Windows later).
 * Implementations must never synthesize Enter / Tab / command chords
 * except a single paste when that is the documented insert method.
 */
export interface DeliveryPlatformAdapter {
  /** Read current clipboard plain text (for restore / conflict checks). */
  clipboardRead(): Promise<ClipboardSnapshot>;
  /** Restore prior clipboard text; fails loudly — caller decides toast. */
  clipboardRestore(prior: string): Promise<void>;
  /** Write plain text to the clipboard. */
  clipboardWrite(text: string): Promise<void>;
  /**
   * Insert plain text into the intended target (macOS: AX selected-text only;
   * no full-field value replacement).
   * Must refuse rather than insert into a different app.
   */
  insertText(text: string, intended: TargetSnapshot): Promise<void>;
  /** Snapshot frontmost app + focused element insertability. */
  snapshotTarget(): Promise<TargetSnapshot>;
  /**
   * Re-check intended target at completion: still present, same identity,
   * still insertable — or classify unavailable / secure / changed / unsupported.
   * Closure must not be inferred from unavailable AX focus alone.
   */
  validateTarget(intended: TargetSnapshot): Promise<TargetSnapshot>;
}

export interface DeliverOptions {
  /** False immediately before a write means the request was cancelled. */
  canWrite?: () => boolean;
  /** Settings `clipboardFallback` — default-on per fixtures / ADR. */
  clipboardFallback: boolean;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Platform adapter (macOS AX / stub / test double). */
  platform: DeliveryPlatformAdapter;
  /** Invocation-time snapshot; null means none taken (treat as unavailable). */
  intended: TargetSnapshot | null;
  /** Transcript text to deliver. */
  text: string;
}

export class DeliveryCancelledError extends Error {
  constructor() {
    super('Delivery cancelled before write');
    this.name = 'DeliveryCancelledError';
  }
}
