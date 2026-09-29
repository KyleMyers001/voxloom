import type {
  Scheduler,
  ShortcutController,
  ShortcutGesture,
} from './contracts';
import {
  createDocumentShortcutController,
  DOUBLE_TAP_MS,
  HOLD_MS,
} from './shortcut';

/**
 * Focused-window mock gesture controller (document keydown/keyup).
 * Hold 320ms / double-tap 260ms are provisional native targets — see
 * docs/decisions/native-shortcut-cancel-focus.md (BUS-12). This is not
 * OS-wide registration; native wiring uses createNativeShortcutController
 * (BUS-13) behind the same gesture contract.
 */

/**
 * Focused-window mock gesture controller (document keydown/keyup).
 * Hold 320ms / double-tap 260ms are provisional native targets — see
 * docs/decisions/native-shortcut-cancel-focus.md (BUS-12). This is not
 * OS-wide registration; native wiring is BUS-13.
 */

interface ShortcutOptions {
  clock: () => number;
  doubleTapMs?: number;
  holdMs?: number;
  onGesture: (gesture: ShortcutGesture) => void;
  scheduler?: Scheduler;
  shortcut: string;
  target: Pick<Document, 'addEventListener' | 'removeEventListener'>;
}

/**
 * Document mock adapter — keeps Vite / unit tests working unchanged.
 * Native Pressed/Released path lives in `shortcut/nativeRegistration.ts`.
 */
export function createShortcutController(
  options: ShortcutOptions,
): ShortcutController {
  return createDocumentShortcutController({
    ...options,
    doubleTapMs: options.doubleTapMs ?? DOUBLE_TAP_MS,
    holdMs: options.holdMs ?? HOLD_MS,
  });
}
