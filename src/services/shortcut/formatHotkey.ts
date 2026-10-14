/**
 * Convert Settings display shortcut (e.g. "Ctrl + Shift + Space") to the
 * Tauri global-shortcut plugin format ("Control+Shift+Space").
 */
export function toPluginHotkey(shortcut: string): string {
  const parts = shortcut
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return shortcut.trim();
  const key = parts.at(-1)!;
  const modifiers = parts.slice(0, -1).map(normalizeModifier);
  return [...modifiers, normalizeKey(key)].join('+');
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

/**
 * Match a KeyboardEvent against a Settings-format shortcut string. The key is
 * compared by physical `code` (as the recorder stores it), so Option+K still
 * matches on layouts where `key` is "å"; `key` is a fallback for other codes.
 */
export function matchesShortcut(
  event: Pick<
    KeyboardEvent,
    'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
  >,
  shortcut: string,
): boolean {
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
