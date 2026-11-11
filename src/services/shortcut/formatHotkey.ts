import { canonicalLoneKey } from './loneKey';

/**
 * Convert Settings display shortcut (e.g. "Ctrl + Shift + Space") to the
 * Tauri global-shortcut plugin format ("Control+Shift+Space").
 */
export function toPluginHotkey(shortcut: string): string {
  // BUS-46: a lone key ("AltRight", "F13") is not a plugin chord. Hand it back
  // untouched so the binder can route it; it is never sent to the plugin.
  const lone = canonicalLoneKey(shortcut);
  if (lone) return lone;
  const parts = shortcut
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return shortcut.trim();
  const key = parts.at(-1)!;
  const modifiers = parts.slice(0, -1).map(normalizeModifier);
  return [...modifiers, normalizeKey(key)].join('+');
}

const SETTINGS_MODIFIER: Record<string, string> = {
  Alt: 'Alt', Command: 'Meta', Control: 'Ctrl', Shift: 'Shift', Super: 'Super',
};

/**
 * Plugin format back to the stored Settings format ("Control+Shift+Space" to
 * "Ctrl + Shift + Space"), for a combo native reports it holds. Undoes
 * toPluginHotkey for every recorded shortcut; a lone key is the same in both.
 */
export function fromPluginHotkey(hotkey: string): string {
  const lone = canonicalLoneKey(hotkey);
  if (lone) return lone;
  const parts = hotkey
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return hotkey.trim();
  const modifiers = parts.slice(0, -1).map((part) => SETTINGS_MODIFIER[part] ?? part);
  return [...modifiers, parts.at(-1)!].join(' + ');
}

function normalizeModifier(part: string): string {
  const lower = part.toLowerCase();
  if (lower === 'ctrl' || lower === 'control') return 'Control';
  if (lower === 'cmd' || lower === 'command' || lower === 'meta') {
    return 'Command';
  }
  if (lower === 'alt' || lower === 'option') return 'Alt';
  if (lower === 'shift') return 'Shift';
  if (lower === 'super') return 'Super';
  return part;
}

function normalizeKey(key: string): string {
  const lower = key.toLowerCase();
  if (lower === 'space' || lower === ' ') return 'Space';
  if (lower.length === 1) return lower.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Physical key code → stored key name ("KeyK" → "k"), matching capture. */
function physicalKey(code: string): string | null {
  const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(code);
  if (m) return (m[1] ?? m[2]).toLowerCase();
  if (code === 'Space' || code === 'Enter' || code === 'Backspace' || code === 'Tab') return code.toLowerCase();
  return null;
}

const OWN_FLAG = {
  AltRight: 'altKey',
  ControlRight: 'ctrlKey',
  MetaRight: 'metaKey',
  ShiftRight: 'shiftKey',
} as const;
const MODIFIER_FLAGS = ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const;

/**
 * Match a KeyboardEvent against a Settings-format shortcut string. The key is
 * compared by physical `code` (as the recorder stores it), so Option+K still
 * matches on layouts where `key` is "å"; `key` is a fallback for other codes.
 *
 * A lone key ("AltRight", "F13") matches its own code. A press also needs
 * every other modifier up, like the native listener, so Shift+Right Option is
 * not the shortcut. A release matches by code alone: it must always end a hold.
 */
export function matchesShortcut(
  event: Pick<
    KeyboardEvent,
    'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
  >,
  shortcut: string,
  phase: 'down' | 'up' = 'down',
): boolean {
  const lone = canonicalLoneKey(shortcut);
  if (lone) {
    if (event.code !== lone) return false;
    if (phase === 'up') return true;
    const own = lone in OWN_FLAG ? OWN_FLAG[lone as keyof typeof OWN_FLAG] : null;
    return MODIFIER_FLAGS.every((flag) => flag === own || !event[flag]);
  }
  const parts = shortcut.toLowerCase().split('+').map((part) => part.trim());
  const key = parts.at(-1);
  const physical = physicalKey(event.code);
  const keyMatches = physical !== null ? physical === key : event.key.toLowerCase() === key;
  return keyMatches &&
    event.altKey === parts.includes('alt') &&
    event.ctrlKey === parts.includes('ctrl') &&
    event.metaKey === parts.includes('meta') &&
    event.shiftKey === parts.includes('shift');
}
