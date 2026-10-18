/** Abort signal handed to queued processing work (BUS-16). */
export interface ProcessingSignal {
  readonly aborted: boolean;
  onAbort(callback: () => void): void;
}
