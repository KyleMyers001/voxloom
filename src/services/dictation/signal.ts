/** Abort signal handed to queued processing work (BUS-16). */
export interface ProcessingSignal {
  readonly aborted: boolean;
  /** Returns a function that removes the listener, when the signal has one. */
  onAbort(callback: () => void): (() => void) | void;
}

/** A ProcessingSignal over an AbortController; listeners can be removed. */
export function signalFor(controller: AbortController): ProcessingSignal {
  return {
    get aborted() {
      return controller.signal.aborted;
    },
    onAbort(callback) {
      controller.signal.addEventListener('abort', callback, { once: true });
      return () => controller.signal.removeEventListener('abort', callback);
    },
  };
}
