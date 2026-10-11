const symbols: Record<string, string> = {
  ctrl: '⌃', control: '⌃',
  shift: '⇧',
  alt: '⌥', option: '⌥', opt: '⌥',
  cmd: '⌘', command: '⌘', meta: '⌘', super: '⌘', commandorcontrol: '⌘', cmdorctrl: '⌘',
};

/** "Ctrl + Shift + Space" → ["⌃", "⇧", "Space"]. Single letters are upper-cased. */
export function comboKeys(combo: string): string[] {
  return combo.split('+').map((part) => part.trim()).filter(Boolean).map((key) => {
    const symbol = symbols[key.toLowerCase()];
    if (symbol) return symbol;
    return key.length === 1 ? key.toUpperCase() : key;
  });
}

export function Kbd({ children }: { children: string }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Renders a shortcut as key caps; the original text is the accessible name. */
export function KeyCombo({ combo }: { combo: string }) {
  return (
    <span aria-label={combo} className="key-combo" role="img">
      {comboKeys(combo).map((key, index) => <Kbd key={`${key}-${index}`}>{key}</Kbd>)}
    </span>
  );
}
