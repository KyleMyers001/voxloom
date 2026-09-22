/**
 * Hold/latch finish can race ahead of React committing `listening`.
 * Keep a one-shot pending flag so finish still runs once listening lands.
 */

export interface PendingFinishGate {
  /** Clear without finishing (cancel / error / success / busy reset). */
  clear(): void;
  /** True when a finish was deferred until listening commits. */
  isPending(): boolean;
  /** Call when dictation enters listening; flushes a deferred finish. */
  onListening(): void;
  /**
   * Request finish. If already listening, finishes immediately; otherwise
   * arms pending for `onListening`.
   */
  requestFinish(listening: boolean, runId: number | null): void;
  /** Reset pending when starting a new hold/latch capture. */
  resetForStart(): void;
}

export interface PendingFinishGateOptions {
  finish: (runId: number) => void;
  /** Current listening run id when kind === listening; else null. */
  listeningRunId: () => number | null;
}

export function createPendingFinishGate({
  finish,
  listeningRunId,
}: PendingFinishGateOptions): PendingFinishGate {
  let pending = false;

  return {
    clear() {
      pending = false;
    },
    isPending() {
      return pending;
    },
    onListening() {
      if (!pending) return;
      pending = false;
      const runId = listeningRunId();
      if (runId !== null) finish(runId);
    },
    requestFinish(listening, runId) {
      if (listening && runId !== null) {
        pending = false;
        finish(runId);
        return;
      }
      pending = true;
    },
    resetForStart() {
      pending = false;
    },
  };
}
