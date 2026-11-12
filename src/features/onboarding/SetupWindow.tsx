import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { type ReactNode, useEffect, useRef } from 'react';
import { beginModal } from '../../app/modalState';
import { focusableSelector, trapTab } from '../../components/focusTrap';

export const SETUP_TITLE = 'Set up Voxloom';
/** The main window's configured title (tauri.conf.json). */
const APP_TITLE = 'Voxloom';

interface SetupWindowProps {
  children: ReactNode;
  onEscape: () => void;
  opener?: HTMLElement | null;
}

function setNativeTitle(title: string) {
  if (isTauri()) void getCurrentWindow().setTitle(title).catch(() => {});
}

/**
 * BUS-216: guided setup is the window itself (approved B / v3), not a sheet
 * over Home. The app hides its shell while this is shown; shortcut and
 * keyboard handling stays paused exactly as it was under the modal.
 */
export function SetupWindow({ children, onEscape, opener }: SetupWindowProps) {
  const root = useRef<HTMLElement>(null);

  useEffect(() => beginModal(), []);

  useEffect(() => {
    const previous = document.title;
    document.title = SETUP_TITLE;
    setNativeTitle(SETUP_TITLE);
    return () => {
      document.title = previous;
      setNativeTitle(APP_TITLE);
    };
  }, []);

  // Focus lands inside setup (the step heading takes over once hydrated);
  // back in the app, focus returns to whatever opened setup.
  useEffect(() => {
    root.current?.querySelector<HTMLElement>(focusableSelector)?.focus();
    return () => opener?.focus();
  }, [opener]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onEscape();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onEscape]);

  return (
    <main
      aria-label={SETUP_TITLE}
      className="setup-window"
      onKeyDown={(event) => trapTab(event, root.current)}
      ref={root}
    >
      {children}
    </main>
  );
}
