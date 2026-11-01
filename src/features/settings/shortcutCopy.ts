/**
 * BUS-47: every line the shortcut recorder shows (designer's final copy).
 * On macOS modifiers are glyphs (⌃⌥⌘); elsewhere they are words.
 */
import { comboLabel, isMacPlatform } from '../../components/KeyCombo';
import { isLoneKey } from '../../services/shortcut/loneKey';
import type { InvalidCapture } from '../../services/shortcut/shortcutCapture';

export const HELP = 'Click, then press keys. Hold to dictate; double-tap to latch.';
export const PROMPT = 'Press keys…';
export const RECORDING = 'Press the new shortcut. Esc cancels.';
export const CANCELED = 'Canceled. Shortcut unchanged.';
/** Marks the saved combo while the OS holds nothing (it is retried next launch). */
export const NOT_ACTIVE = 'not active';
/** Home and sidebar when no shortcut is registered. */
export const NO_SHORTCUT_HEADING = 'No shortcut is active';
export const NO_SHORTCUT_HINT = 'Record one in Settings.';
export const NO_SHORTCUT = `${NO_SHORTCUT_HEADING}. ${NO_SHORTCUT_HINT}`;

const mods = (mac: boolean) => (mac ? '⌃, ⌥, ⌘ or ⇧' : 'Ctrl, Alt, Super or Shift');
const L = (combo: string, mac: boolean) => comboLabel(combo, mac);

export const addAKey = (mac = isMacPlatform()) =>
  `Add a key: hold ${mods(mac)} and press a letter, number or Space.`;
export const pendingText = (combo: string, mac = isMacPlatform()) => `Setting ${L(combo, mac)}…`;
/** Shift is held while typing capitals, so a lone Shift shortcut can misfire. */
const shiftWarning = (mac: boolean) =>
  ` Right ${mac ? '⇧' : 'Shift'} is also used for typing, so it may start dictation by accident.`;
export const successText = (combo: string, mac = isMacPlatform()) =>
  `Shortcut set to ${L(combo, mac)}.${combo === 'ShiftRight' ? shiftWarning(mac) : ''}`;
export const resetText = (combo: string, mac = isMacPlatform()) => `Shortcut reset to ${L(combo, mac)}.`;
export const timeoutText = (combo: string, mac = isMacPlatform()) =>
  `Still waiting for ${L(combo, mac)}. Try it, or record again.`;
export const inUseText = (combo: string, kept: string, mac = isMacPlatform()) =>
  `${L(combo, mac)} is in use by another app. Kept ${L(kept, mac)}.`;
/** Onboarding's browser-prototype collision (no OS registration, so it's simulated). */
export const onboardingInUseText = (combo: string, kept: string, mac = isMacPlatform()) =>
  `${L(combo, mac)} is in use by another app (simulated). Kept ${L(kept, mac)}. Record a different one.`;

/** The new combo was refused and restoring the previous one failed too. */
export function noneActiveText(combo: string, previous: string | null | undefined, mac = isMacPlatform()) {
  if (isLoneKey(combo)) return `${loneReason(combo, mac)} No shortcut is active. Record one.`;
  const restore = previous ? ` or restore ${L(previous, mac)}` : '';
  return `Couldn't set ${L(combo, mac)}${restore}. No shortcut is active. Record one.`;
}

const ARROWS: Record<string, string> = {
  ArrowDown: 'Down Arrow', ArrowLeft: 'Left Arrow', ArrowRight: 'Right Arrow', ArrowUp: 'Up Arrow',
};

/** What the keyboard calls a key we can't bind ("Up Arrow", "F5", "Keypad 7"). */
export function displayKey(code: string, key: string, mac = isMacPlatform()): string {
  if (ARROWS[code]) return ARROWS[code];
  if (/^F\d{1,2}$/.test(code)) return code;
  const pad = /^Numpad(.+)$/.exec(code);
  if (pad) return `Keypad ${pad[1]}`;
  if (code === 'Delete') return mac ? 'Forward Delete' : 'Delete';
  if (code === 'Escape') return 'Esc';
  if (key && key.length === 1 && key !== ' ') return key.toUpperCase();
  return key && key !== 'Unidentified' ? key : code || 'That key';
}

export function invalidText(invalid: InvalidCapture, mac = isMacPlatform()): string {
  switch (invalid.reason) {
    case 'unsupported': {
      const named = mac ? 'Space, Return, Delete' : 'Space, Enter, Backspace';
      return `${displayKey(invalid.code, invalid.key, mac)} can't be used. Use a letter, number, ${named} or Tab.`;
    }
    case 'numpad-enter':
      return `Keypad Enter can't be used. Use ${mac ? 'Return' : 'the main Enter key'} instead.`;
    case 'no-modifier':
      return `Add ${mods(mac)} to ${L(invalid.key, mac)}.`;
    case 'f-key-combo':
      return `${invalid.key} works on its own. Press it without ${mods(mac)}.`;
    case 'left-modifier': {
      const mod = invalid.code.replace(/Left$/, '');
      const use = invalid.suggest ? ` Use ${L(invalid.suggest, mac)} instead.` : '';
      return `Left ${L(mod, mac)} can't be used on its own.${use}`;
    }
    case 'reserved':
      return `macOS uses ${L(invalid.combo, mac)} for ${invalid.feature}. Choose another.`;
  }
}

const INPUT_MONITORING = 'System Settings › Privacy & Security › Input Monitoring';

/** Why a lone key was refused: macOS Input Monitoring is off, or this isn't macOS. */
function loneReason(combo: string, mac: boolean) {
  return mac
    ? `${L(combo, mac)} needs Input Monitoring. Allow Voxloom in ${INPUT_MONITORING}.`
    : `${L(combo, mac)} on its own only works on macOS.`;
}

/**
 * The recorder's line when a lone key was refused and the previous shortcut
 * stays. macOS asks once on save and answers after we've already refused, so
 * it says to record the key again; a relaunch is the fallback because whether
 * a running app sees a fresh grant is not something we can promise.
 */
export const loneRefusedText = (combo: string, kept: string, mac = isMacPlatform()) => {
  const again = mac ? ' Then record it again; relaunch Voxloom if that doesn\'t help.' : '';
  return `${loneReason(combo, mac)}${again} Kept ${L(kept, mac)}.`;
};

/** Toast (Settings closed) when the new shortcut was refused and another one is now active. */
export function usingInsteadText(combo: string, active: string, mac = isMacPlatform()) {
  const why = isLoneKey(combo) ? loneReason(combo, mac) : `${L(combo, mac)} is in use by another app.`;
  return `${why} Using ${L(active, mac)} instead.`;
}

/** Main-window toast when the saved shortcut can't be registered at launch. */
export function bootRefusedText(combo: string, active: string | null | undefined, mac = isMacPlatform()) {
  const why = isLoneKey(combo) ? loneReason(combo, mac) : `${L(combo, mac)} is in use by another app.`;
  const now = active ? ` Using ${L(active, mac)} instead.` : ' No shortcut is active.';
  return `${why}${now} Record one in Settings.`;
}
