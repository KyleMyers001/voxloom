/**
 * BUS-47: turn a keydown into a stored shortcut ("Ctrl + Shift + Space").
 *
 * Accepted keys mirror what native registration and hold-release can watch
 * (parse_plugin_hotkey / key_to_code in src-tauri/src/hold_release.rs):
 * A–Z, 0–9, Space, Enter, Backspace, Tab, plus at least one modifier
 * (Shift alone is allowed, as decided on #54). Esc is never bindable (BUS-12) and cancels recording.
 * NumpadEnter is rejected: native watches only the main Return key (36).
 * Modifier-only shortcuts (Right Option, Fn) are BUS-46.
 */
import { isMacPlatform } from '../../components/KeyCombo';
export type CaptureKeyEvent = Pick<
  KeyboardEvent,
  'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
>;

export type CaptureResult =
  | { kind: 'captured'; combo: string }
  | { kind: 'cancel'; reason: 'escape' | 'tab' }
  | { kind: 'modifier-only'; preview: string }
  | { kind: 'invalid'; invalid: InvalidCapture };

/** Why a chord can't be recorded; the recorder turns this into copy. */
export type InvalidCapture =
  | { reason: 'unsupported'; code: string; key: string }
  | { reason: 'numpad-enter' }
  | { reason: 'no-modifier'; key: string }
  | { reason: 'reserved'; combo: string; feature: string };

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

/** macOS-only reserved combos (stored format) → what macOS uses them for. */
export const RESERVED: Record<string, string> = {
  'Alt + Meta + Space': 'Finder search',
  'Ctrl + Meta + Q': 'Lock Screen',
  'Ctrl + Meta + Space': 'the Character Viewer',
  'Ctrl + Space': 'switching input sources',
  'Meta + H': 'hiding apps',
  'Meta + M': 'minimizing windows',
  'Meta + Q': 'quitting apps',
  'Meta + Space': 'Spotlight',
  'Meta + Tab': 'the app switcher',
  'Meta + W': 'closing windows',
  'Shift + Meta + 3': 'screenshots',
  'Shift + Meta + 4': 'screenshots',
  'Shift + Meta + 5': 'screenshots',
};

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

export function captureShortcut(event: CaptureKeyEvent, mac = isMacPlatform()): CaptureResult {
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
  // Detect by code: keypad Enter reports key "Enter" like Return does.
  if (event.code === 'NumpadEnter') return { invalid: { reason: 'numpad-enter' }, kind: 'invalid' };
  const key = keyName(event.code);
  if (!key) {
    return { invalid: { code: event.code, key: event.key, reason: 'unsupported' }, kind: 'invalid' };
  }
  if (mods.length === 0) return { invalid: { key, reason: 'no-modifier' }, kind: 'invalid' };
  const combo = sortedForReserved(mods, key);
  // These are macOS system shortcuts; elsewhere the OS reports real conflicts.
  const feature = mac ? RESERVED[combo] : undefined;
  if (feature) return { invalid: { combo, feature, reason: 'reserved' }, kind: 'invalid' };
  return { combo, kind: 'captured' };
}
