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

/** Match a KeyboardEvent against a Settings-format shortcut string. */
export function matchesShortcut(
  event: Pick<
    KeyboardEvent,
    'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
  >,
  shortcut: string,
): boolean {
  const parts = shortcut.toLowerCase().split('+').map((part) => part.trim());
  const key = parts.at(-1);
  const space = key === 'space' && event.code === 'Space';
  return (space || event.key.toLowerCase() === key) &&
    event.altKey === parts.includes('alt') &&
    event.ctrlKey === parts.includes('ctrl') &&
    event.metaKey === parts.includes('meta') &&
    event.shiftKey === parts.includes('shift');
}
