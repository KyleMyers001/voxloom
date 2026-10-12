/**
 * BUS-47: every line the shortcut recorder shows (designer's final copy).
 * On macOS modifiers are glyphs (⌃⌥⌘); elsewhere they are words.
 */
import { comboLabel, isMacPlatform } from '../../components/KeyCombo';
import type { InvalidCapture } from '../../services/shortcut/shortcutCapture';

export const HELP = 'Click, then press keys. Hold to dictate; double-tap to latch.';
export const PROMPT = 'Press keys…';
export const RECORDING = 'Press the new shortcut. Esc cancels.';
export const CANCELED = 'Canceled. Shortcut unchanged.';

const mods = (mac: boolean) => (mac ? '⌃, ⌥ or ⌘' : 'Ctrl, Alt or Super');
const L = (combo: string, mac: boolean) => comboLabel(combo, mac);

export const addAKey = (mac = isMacPlatform()) =>
  `Add a key: hold ${mods(mac)} and press a letter, number or Space.`;
export const pendingText = (combo: string, mac = isMacPlatform()) => `Setting ${L(combo, mac)}…`;
export const successText = (combo: string, mac = isMacPlatform()) => `Shortcut set to ${L(combo, mac)}.`;
export const resetText = (combo: string, mac = isMacPlatform()) => `Shortcut reset to ${L(combo, mac)}.`;
export const timeoutText = (combo: string, mac = isMacPlatform()) =>
  `Still waiting for ${L(combo, mac)}. Try it, or record again.`;
export const inUseText = (combo: string, kept: string, mac = isMacPlatform()) =>
  `${L(combo, mac)} is in use by another app. Kept ${L(kept, mac)}.`;

/** The new combo was refused and restoring the previous one failed too. */
export function noneActiveText(combo: string, previous: string | null | undefined, mac = isMacPlatform()) {
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
    case 'shift-only':
      return `Shift alone isn't enough. Add ${mods(mac)}.`;
    case 'reserved':
      return `macOS uses ${L(invalid.combo, mac)} for ${invalid.feature}. Choose another.`;
  }
}

/** Main-window toast when the saved shortcut can't be registered at launch. */
export function bootRefusedText(combo: string, active: string | null | undefined, mac = isMacPlatform()) {
  const now = active ? ` Using ${comboLabel(active, mac)} for now.` : ' No shortcut is active.';
  return `${L(combo, mac)} is in use by another app.${now} Record one in Settings.`;
}
