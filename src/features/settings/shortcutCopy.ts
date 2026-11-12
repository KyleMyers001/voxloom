/**
 * BUS-47: every line the shortcut recorder shows (designer's final copy).
 * On macOS modifiers are glyphs (⌃⌥⌘); elsewhere they are words.
 */
import { comboKeys, comboLabel, isMacPlatform } from '../../components/KeyCombo';
import { isLoneKey, loneKeyCap, spokenLoneKey } from '../../services/shortcut/loneKey';
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
export const shiftWarning = (mac: boolean) =>
  ` Right ${mac ? '⇧' : 'Shift'} is also used for typing, so it may start dictation by accident.`;
export const successText = (combo: string, mac = isMacPlatform()) =>
  `Shortcut set to ${L(combo, mac)}.${combo === 'ShiftRight' ? shiftWarning(mac) : ''}`;
export const resetText = (combo: string, mac = isMacPlatform()) => `Shortcut reset to ${L(combo, mac)}.`;
export const timeoutText = (combo: string, mac = isMacPlatform()) =>
  `Still waiting for ${L(combo, mac)}. Try it, or record again.`;
export const inUseText = (combo: string, kept: string, mac = isMacPlatform()) =>
  `${L(combo, mac)} is in use by another app. Kept ${L(kept, mac)}.`;

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

const ACCESSIBILITY = 'System Settings › Privacy & Security › Accessibility';

/** Why a lone key was refused: macOS Accessibility is off, or this isn't macOS. */
function loneReason(combo: string, mac: boolean) {
  return mac
    ? `${L(combo, mac)} needs Accessibility. Allow Voxloom in ${ACCESSIBILITY}.`
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
  // The key stays saved, so recording it again retries it.
  return `${why}${now} Record it again in Settings.`;
}

/**
 * BUS-219: guided setup step 2 ("Your shortcut") card, Option A. Written for
 * a first-time user: no raw key codes, no "latch" or "binding".
 */
export const CARD_LABEL = 'Your shortcut';
export const CARD_DEFAULT_PILL = 'Default';
export const CARD_CHANGE = 'Change shortcut';
export const CARD_RECORDING_LABEL = 'Now press the keys you want to use';
export const CARD_PROMPT = 'Waiting for your keys…';
export const CARD_RECORDING_HELP = 'Press them together, like ⌃ ⌥ Space, or press one key, like Right Option. Changed your mind? Press Esc or choose Cancel to keep your current shortcut.';
export const CARD_CANCEL = 'Cancel';

/** "key" for a lone key such as Right Option, "keys" for a combo. */
export const holdHint = (shortcut: string) =>
  `Hold the ${isLoneKey(shortcut) ? 'key' : 'keys'} while you talk. Let go when you’re done.`;

/** Lone key: "Right Option (⌥)"; combo: "⌃⇧Space". */
export function shortcutName(shortcut: string, mac = isMacPlatform()): string {
  const spoken = spokenLoneKey(shortcut, mac);
  if (!spoken) return L(shortcut, mac);
  const cap = loneKeyCap(shortcut, mac);
  return cap && cap !== spoken ? `${spoken} (${cap})` : spoken;
}

export const resetLinkText = (combo: string, mac = isMacPlatform()) =>
  `Go back to the default (${comboKeys(combo, mac).join(' ')})`;
export const savedText = (combo: string, mac = isMacPlatform()) =>
  `Saved. On the next step, hold ${shortcutName(combo, mac)} to try it.${combo === 'ShiftRight' ? shiftWarning(mac) : ''}`;
export const cardInUseText = (combo: string, kept: string, mac = isMacPlatform()) =>
  `Another app already uses ${shortcutName(combo, mac)}, so we kept your current shortcut, ${shortcutName(kept, mac)}. Try different keys.`;
export const cardNoneActiveText = (combo: string, mac = isMacPlatform()) =>
  `${shortcutName(combo, mac)} didn’t work, and no shortcut is set right now. Try different keys, or go back to the default.`;
