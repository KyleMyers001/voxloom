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
      if (event.key === '?' && !target.matches('input, select, textarea')) {
        onHelp(target);
        return;
      }
      if (event.metaKey && event.key === ',') {
        event.preventDefault();
        onNavigate('settings');
        return;
      }
      // event.code: on macOS, Option+1 reports key "¡", so match the physical digit.
      const digit = /^Digit[1-4]$/.test(event.code) ? event.code.slice(5) : event.key;
      const screen = event.altKey ? screenForAltDigit(digit) : null;
      if (screen) onNavigate(screen);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [blocked, onHelp, onNavigate]);
}
