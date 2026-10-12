import { useEffect } from 'react';
import type { Screen } from '../domain/types';
import { hasOpenModal } from './modalState';
import { screenForAltDigit } from './shell/screens';

type Options = {
  blocked: boolean;
  onHelp: (opener: HTMLElement) => void;
  onNavigate: (screen: Screen) => void;
};

/** "?" opens shortcuts; ⌥1–3 navigate; ⌥4 and ⌘, open Settings. Suppressed under modals. */
export function useAppKeys({ blocked, onHelp, onNavigate }: Options) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (blocked || hasOpenModal()) return;
      const target = event.target as HTMLElement;
      const typing = event.isComposing || isEditable(target);
      if (event.key === '?' && !typing) {
        onHelp(target);
        return;
      }
      if (event.metaKey && event.key === ',') {
        event.preventDefault();
        onNavigate('settings');
        return;
      }
      // ⌥ alone, never while typing (Option+digit types characters on macOS).
      if (typing || !event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      // event.code: on macOS, Option+1 reports key "¡", so match the physical digit.
      const digit = /^Digit[1-4]$/.test(event.code) ? event.code.slice(5) : event.key;
      const screen = screenForAltDigit(digit);
      if (!screen) return;
      event.preventDefault();
      onNavigate(screen);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [blocked, onHelp, onNavigate]);
}

// Inputs that don't take typed text: ⌥-digit and ? still work while these are focused.
const nonTextInputs = new Set([
  'radio', 'checkbox', 'range', 'button', 'submit', 'reset', 'color', 'file', 'image', 'hidden',
]);

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLInputElement) return !nonTextInputs.has(target.type);
  return target.matches('textarea, select, [contenteditable]:not([contenteditable="false"])');
}
