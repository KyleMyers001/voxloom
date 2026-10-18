import type { Scheduler, ShortcutGesture } from '../contracts';
import type { GestureMachine } from './gestureMachine';
import type { HoldReleaseApi } from './holdReleaseBridge';
import type { RegisterOutcome } from './registerOrRevert';
import type { NativeShortcutApi } from './tauriShortcutApi';

export interface NativeShortcutController {
  activeHotkey(): string | null;
  dispose(): Promise<void>;
  lastKnownGood(): string | null;
  /**
   * Apply a Settings-format shortcut. On failure, re-binds last-known-good
   * and returns an honest outcome for Settings/toast.
   */
  setShortcut(settingsShortcut: string): Promise<RegisterOutcome>;
  /**
   * BUS-69: unbind the OS hotkey while a recorder records (Carbon hotkeys
   * swallow the keystroke, so the recorder would never see the current
   * combo), and re-bind it afterwards.
   */
  suspendBinding(on: boolean): Promise<void>;
  setContext: GestureMachine['setContext'];
  resetPartial: GestureMachine['resetPartial'];
}

export interface NativeShortcutControllerOptions {
  api?: NativeShortcutApi;
  /**
   * Post-arm ms to ignore Carbon Released (spurious focus race). After this,
   * Carbon Released finishes even while the Mac poll/tap watch monitors.
   */
  carbonReleaseGraceMs?: number;
  clock: () => number;
  doubleTapMs?: number;
  holdMs?: number;
  holdRelease?: HoldReleaseApi;
  onGesture: (gesture: ShortcutGesture) => void;
  onRegisterFailure?: (message: string) => void;
  /**
   * BUS-69: suspendBinding could not unbind ('unbind': the hotkey stays
   * active) or could not re-bind after a retry ('rebind': nothing active).
   */
  onSuspendFailure?: (kind: 'unbind' | 'rebind', message: string) => void;
  /** BUS-69: a later resume re-bound the hotkey after a reported 'rebind' failure. */
  onSuspendRecovered?: () => void;
  scheduler: Scheduler;
}
