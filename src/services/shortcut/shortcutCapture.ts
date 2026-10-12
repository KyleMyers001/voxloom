/**
 * BUS-47: turn a keydown into a stored shortcut ("Ctrl + Shift + Space").
 *
 * Accepted keys mirror what native registration and hold-release can watch
 * (parse_plugin_hotkey / key_to_code in src-tauri/src/hold_release.rs):
 * A–Z, 0–9, Space, Enter, Backspace, Tab, plus at least one modifier other
 * than Shift. Esc is never bindable (BUS-12) and cancels recording.
 * NumpadEnter is rejected: native watches only the main Return key (36).
 * Modifier-only shortcuts (Right Option, Fn) are BUS-46.
 */
export type CaptureKeyEvent = Pick<
  KeyboardEvent,
  'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
>;

export type CaptureResult =
  | { kind: 'captured'; combo: string }
  | { kind: 'cancel'; reason: 'escape' | 'tab' }
  | { kind: 'modifier-only'; preview: string }
  | { kind: 'invalid'; message: string };

const MODIFIER_CODES = new Set([
  'AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'MetaLeft',
  'MetaRight', 'ShiftLeft', 'ShiftRight', 'OSLeft', 'OSRight', 'Fn',
]);
const MODIFIER_KEYS = new Set(['Alt', 'Control', 'Meta', 'Shift', 'OS', 'Fn', 'AltGraph']);

const NAMED: Record<string, string> = {
  Backspace: 'Backspace',
  Enter: 'Enter',
  Space: 'Space',
  Tab: 'Tab',
};

/** macOS reserved combos (stored format) blocked with a warning. */
const RESERVED: Record<string, string> = {
  'Ctrl + Space': 'input source switching',
  'Meta + H': 'Hide app',
  'Meta + M': 'Minimize',
  'Meta + Q': 'Quit',
  'Meta + Space': 'Spotlight',
  'Meta + Tab': 'the app switcher',
  'Meta + W': 'Close window',
  'Shift + Meta + 3': 'screenshots',
  'Shift + Meta + 4': 'screenshots',
  'Shift + Meta + 5': 'screenshots',
};

export const ADD_A_KEY = 'Add a key: hold a modifier and press a letter, number or Space.';

function modifierParts(event: CaptureKeyEvent): string[] {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');
  return parts;
}

/** Physical key → stored key name, or null when native can't register it. */
export function keyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  return NAMED[code] ?? null;
}

function sortedForReserved(mods: string[], key: string): string {
  const order = ['Ctrl', 'Alt', 'Shift', 'Meta'];
  const sorted = [...mods].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...sorted, key].join(' + ');
}

export function captureShortcut(event: CaptureKeyEvent): CaptureResult {
  const mods = modifierParts(event);
  if (event.key === 'Escape' || event.code === 'Escape') {
    return { kind: 'cancel', reason: 'escape' };
  }
  if (MODIFIER_CODES.has(event.code) || MODIFIER_KEYS.has(event.key)) {
    return { kind: 'modifier-only', preview: mods.join(' + ') };
  }
  // Tab and Shift+Tab move focus (cancel); they're never recorded alone.
  if (event.code === 'Tab' && (mods.length === 0 || (mods.length === 1 && mods[0] === 'Shift'))) {
    return { kind: 'cancel', reason: 'tab' };
  }
  const key = keyName(event.code);
  if (!key) {
    return {
      kind: 'invalid',
      message: `${event.key || event.code} can't be used. Choose a letter, number, Space, Enter, Backspace or Tab.`,
    };
  }
  if (mods.length === 0) {
    return { kind: 'invalid', message: `Add a modifier (⌃, ⌥ or ⌘) to ${key}.` };
  }
  if (mods.length === 1 && mods[0] === 'Shift') {
    return { kind: 'invalid', message: 'Shift alone isn\'t enough. Add ⌃, ⌥ or ⌘.' };
  }
  const combo = sortedForReserved(mods, key);
  const reserved = RESERVED[combo];
  if (reserved) {
    return { kind: 'invalid', message: `Reserved by macOS for ${reserved}. Choose another.` };
  }
  return { combo, kind: 'captured' };
}
