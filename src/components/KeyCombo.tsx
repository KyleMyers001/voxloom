const symbols: Record<string, string> = {
  ctrl: '⌃', control: '⌃',
  shift: '⇧',
  alt: '⌥', option: '⌥', opt: '⌥',
  cmd: '⌘', command: '⌘', meta: '⌘', super: '⌘',
};

const cmdOrCtrl = new Set(['commandorcontrol', 'cmdorctrl']);

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/**
 * "Ctrl + Shift + Space" → ["⌃", "⇧", "Space"]. Single letters are upper-cased.
 * CommandOrControl is ⌘ on macOS and "Ctrl" elsewhere.
 */
export function comboKeys(combo: string, mac = isMacPlatform()): string[] {
  return combo.split('+').map((part) => part.trim()).filter(Boolean).map((key) => {
    if (cmdOrCtrl.has(key.toLowerCase())) return mac ? '⌘' : 'Ctrl';
    const symbol = symbols[key.toLowerCase()];
    if (symbol) return symbol;
    return key.length === 1 ? key.toUpperCase() : key;
  });
}

export function Kbd({ children }: { children: string }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Renders a shortcut as key caps; screen readers get the original text. */
export function KeyCombo({ combo }: { combo: string }) {
  return (
    <span className="key-combo">
      <span aria-hidden="true" className="key-combo__caps">
        {comboKeys(combo).map((key, index) => <Kbd key={`${key}-${index}`}>{key}</Kbd>)}
      </span>
      <span className="sr-only">{combo}</span>
    </span>
  );
}
