import type { KeyboardEvent } from 'react';

export const focusableSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
].join(',');

/** Keep Tab and Shift+Tab cycling inside `container`. */
export function trapTab(event: KeyboardEvent, container: HTMLElement | null) {
  if (event.key !== 'Tab' || !container) return;
  const focusable = [...container.querySelectorAll<HTMLElement>(focusableSelector)]
    .filter((element) => !element.hidden);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
