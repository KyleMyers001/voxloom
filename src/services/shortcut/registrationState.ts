import type { GestureMachine } from './gestureMachine';
import type { ShortcutBinder } from './registerOrRevert';
import type { NativeShortcutApi } from './tauriShortcutApi';

/** Controller state shared by the setShortcut and suspendBinding runners. */
export interface RegistrationState {
  getActive: () => string | null;
  setActive: (hotkey: string | null) => void;
  getLastKnownGood: () => string | null;
  setLastKnownGood: (hotkey: string | null) => void;
  getSuspendedHotkey: () => string | null;
  setSuspendedHotkey: (hotkey: string | null) => void;
  getRecording: () => boolean;
  setRecording: (on: boolean) => void;
  getRebindFailed: () => boolean;
  setRebindFailed: (v: boolean) => void;
  isDisposed: () => boolean;
  bumpGeneration: () => void;
  api: NativeShortcutApi;
  binder: ShortcutBinder;
  machine: GestureMachine;
  disarmHoldWatch: () => void;
  onRegisterFailure?: (message: string) => void;
  onSuspendFailure?: (kind: 'unbind' | 'rebind', message: string) => void;
  onSuspendRecovered?: () => void;
}
