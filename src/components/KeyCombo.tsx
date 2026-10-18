const symbols: Record<string, string> = {
  ctrl: '⌃', control: '⌃',
  shift: '⇧',
  alt: '⌥', option: '⌥', opt: '⌥',
  cmd: '⌘', command: '⌘', meta: '⌘', super: '⌘',
};

const cmdOrCtrl = new Set(['commandorcontrol', 'cmdorctrl']);

/** Off macOS the ⌃⇧⌥ glyphs mean nothing on the keyboard: spell modifiers out. */
const words: Record<string, string> = {
  alt: 'Alt', cmd: 'Super', command: 'Super', control: 'Ctrl', ctrl: 'Ctrl', meta: 'Super',
  opt: 'Alt', option: 'Alt', shift: 'Shift', super: 'Super',
};

/** Stored key names macOS keyboards label differently. */
const macKeys: Record<string, string> = { backspace: 'Delete', enter: 'Return' };

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/**
 * "Ctrl + Shift + Space" → ["⌃", "⇧", "Space"]. Single letters are upper-cased.
 * On macOS modifiers are glyphs (⌃⇧⌥⌘); elsewhere they are words (Ctrl,
 * Shift, Alt, Super). Enter/Backspace read Return/Delete on macOS. CommandOrControl is ⌘ on macOS and "Ctrl" elsewhere.
 */
export function comboKeys(combo: string, mac = isMacPlatform()): string[] {
  return combo.split('+').map((part) => part.trim()).filter(Boolean).map((key) => {
    if (cmdOrCtrl.has(key.toLowerCase())) return mac ? '⌘' : 'Ctrl';
    if (!mac && words[key.toLowerCase()]) return words[key.toLowerCase()];
    const symbol = symbols[key.toLowerCase()];
    if (symbol) return symbol;
    if (mac && macKeys[key.toLowerCase()]) return macKeys[key.toLowerCase()];
    return key.length === 1 ? key.toUpperCase() : key;
  });
}

/** One-line label: "⌃⇧Space" on macOS, "Ctrl+Shift+Space" elsewhere. */
export function comboLabel(combo: string, mac = isMacPlatform()): string {
  return comboKeys(combo, mac).join(mac ? '' : '+');
}

const spokenMac: Record<string, string> = {
  alt: 'Option', backspace: 'Delete', cmd: 'Command', command: 'Command', ctrl: 'Control',
  enter: 'Return', meta: 'Command', opt: 'Option', option: 'Option', super: 'Command',
};
const spokenOther: Record<string, string> = {
  alt: 'Alt', cmd: 'Super', command: 'Super', ctrl: 'Control', meta: 'Super', opt: 'Alt', option: 'Alt',
};

/** "Ctrl + Meta + Space" → "Control Command Space": what VoiceOver should say. */
export function spokenCombo(combo: string, mac = isMacPlatform()): string {
  const names = mac ? spokenMac : spokenOther;
  return combo.split('+').map((part) => part.trim()).filter(Boolean)
    .map((part) => names[part.toLowerCase()] ?? (part.length === 1 ? part.toUpperCase() : part)).join(' ');
}

export function Kbd({ children }: { children: string }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Renders a shortcut as key caps; screen readers get the spoken names. */
export function KeyCombo({ combo }: { combo: string }) {
  return (
    <span className="key-combo">
      <span aria-hidden="true" className="key-combo__caps">
        {comboKeys(combo).map((key, index) => <Kbd key={`${key}-${index}`}>{key}</Kbd>)}
      </span>
      <span className="sr-only">{spokenCombo(combo)}</span>
    </span>
  );
}
