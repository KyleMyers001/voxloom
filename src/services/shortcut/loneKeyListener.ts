import type { GestureMachine } from './gestureMachine';
import type { LoneKeyApi } from './loneKeyBridge';

interface Options {
  api: LoneKeyApi;
  /** Stops an in-flight hold-release watch (the tap reports its own release). */
  disarmHoldWatch(): void;
  /** True once the controller is disposed. */
  isDisposed(): boolean;
  /** True while a lone key is the active shortcut. */
  isLoneKeyActive(): boolean;
  machine: GestureMachine;
  /** The native listener stopped because Accessibility went away. */
  onAccessLost(): void;
}

/**
 * Edges from the native lone-key tap drive the same gesture machine as the
 * plugin's Pressed / Released. They are dropped unless a lone key is the active
 * shortcut (an edge already in flight when it was unbound or suspended).
 * Returns a stop function that is safe before the subscription resolves.
 */
export function listenForLoneKey({
  api, disarmHoldWatch, isDisposed, isLoneKeyActive, machine, onAccessLost,
}: Options): () => void {
  let unlisten: (() => void) | null = null;
  let stopped = false;
  void api.listen((edge) => {
    if (stopped || isDisposed() || !isLoneKeyActive()) return;
    if (edge === 'access-lost') {
      disarmHoldWatch();
      machine.finishActive();
      onAccessLost();
      return;
    }
    if (edge === 'cancelled') {
      // An active latch (the double-tap's second press survived the debounce
      // before a chord key joined it) gets its finish, so capture stops.
      disarmHoldWatch();
      machine.finishActive();
      return;
    }
    machine.handle(edge);
  }).then((fn) => {
    if (stopped) fn();
    else unlisten = fn;
  }).catch(() => undefined);
  return () => {
    stopped = true;
    unlisten?.();
    unlisten = null;
  };
}
