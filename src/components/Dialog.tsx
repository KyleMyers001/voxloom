import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { focusableSelector as selector, trapTab } from './focusTrap';
import { Icon } from './Icon';
import { beginModal } from '../app/modalState';

interface DialogProps {
  children: ReactNode;
  /** CSS selector for the element focused on open; defaults to the first focusable. */
  initialFocus?: string;
  label: string;
  onClose: () => void;
  /** Override only the Escape action (e.g. cancel dictation but retain the note). */
  onEscape?: () => void;
  opener?: HTMLElement | null;
}

export function Dialog({ children, initialFocus, label, onClose, onEscape, opener }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => beginModal(), []);

  useEffect(() => {
    const root = document.querySelector<HTMLElement>('#root');
    const wasHidden = root?.getAttribute('aria-hidden');
    const wasInert = root?.inert ?? false;
    if (root) {
      root.inert = true;
      root.setAttribute('aria-hidden', 'true');
    }
    const panelEl = panel.current;
    (panelEl?.querySelector<HTMLElement>(initialFocus ?? selector)
      ?? panelEl?.querySelector<HTMLElement>(selector))?.focus();
    return () => {
      if (root) {
        root.inert = wasInert;
        if (wasHidden === null) root.removeAttribute('aria-hidden');
        else root.setAttribute('aria-hidden', wasHidden ?? 'true');
      }
      opener?.focus();
    };
  }, [initialFocus, opener]);

  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      (onEscape ?? onClose)();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose, onEscape]);

  return createPortal(
    <div
      aria-label={label}
      aria-modal="true"
      className="overlay"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
      onKeyDown={(event) => trapTab(event, panel.current)}
      role="dialog"
    >
      <div className="overlay__panel" onMouseDown={(event) =>
        event.stopPropagation()} ref={panel}>
        <button
          aria-label={`Close ${label}`}
          className="xbtn modal-close"
          onClick={onClose}
          type="button"
        >
          <Icon name="x" size={12} />
        </button>
        {children}
      </div>
    </div>,
    document.body,
  );
}
