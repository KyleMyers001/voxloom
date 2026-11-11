import type { Scheduler, ShortcutGesture } from '../contracts';
import type { GestureMachine } from './gestureMachine';
import type { HoldReleaseApi } from './holdReleaseBridge';
import type { LoneKeyApi } from './loneKeyBridge';
import type { RegisterOutcome } from './registerOrRevert';
import type { NativeShortcutApi } from './tauriShortcutApi';

export interface SetShortcutOptions {
  /**
   * The user just saved this shortcut. Only then may a lone key ask macOS for
   * Accessibility (a system prompt); boot and revert never do.
   */
  userInitiated?: boolean;
}

export interface NativeShortcutController {
  activeHotkey(): string | null;
  dispose(): Promise<void>;
  lastKnownGood(): string | null;
  /**
   * Apply a Settings-format shortcut. On failure, re-binds last-known-good
   * and returns an honest outcome for Settings/toast.
   */
  setShortcut(
    settingsShortcut: string,
    options?: SetShortcutOptions,
  ): Promise<RegisterOutcome>;
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
  /** BUS-46: native listener for a lone key as the shortcut. */
  loneKey?: LoneKeyApi;
  onGesture: (gesture: ShortcutGesture) => void;
  /**
   * BUS-209: the active lone key stopped listening (macOS Accessibility was
   * turned off). Nothing is active now; a save or relaunch re-arms it.
   */
  onBindingLost?: (message: string) => void;
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
