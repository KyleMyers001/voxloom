// BUS-47 QA s7: when the OS holds no shortcut, Home and the sidebar say so.
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from '../../src/app/shell/Sidebar';
import { HomeHero } from '../../src/features/home/HomeHero';
import { NO_SHORTCUT, NO_SHORTCUT_HINT } from '../../src/features/settings/shortcutCopy';
import { resetActiveShortcut, setActiveShortcut } from '../../src/services/shortcut/activeShortcut';
import { renderWithApp } from './testUtils';

const DEFAULT = 'Ctrl + Shift + Space';

describe('no active shortcut in the main window', () => {
  beforeEach(() => resetActiveShortcut());

  it('Home says so instead of "Hold …"', () => {
    setActiveShortcut(null);
    renderWithApp(<HomeHero isNative />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^No shortcut is active$/);
    expect(screen.getByText('Record one in Settings.')).toBeInTheDocument();
    expect(NO_SHORTCUT_HINT).toBe('Record one in Settings.');
    expect(screen.queryByText(/^Hold/)).toBeNull();
  });

  it('Home shows the shortcut while it is active', () => {
    renderWithApp(<HomeHero isNative />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Hold .* to dictate$/);
  });

  it('the sidebar says so too', () => {
    setActiveShortcut(null);
    renderWithApp(
      <Sidebar onNavigate={vi.fn()} onReset={vi.fn()} onScenario={vi.fn()} screen="home" shortcut={DEFAULT} status="Ready" />,
    );
    expect(NO_SHORTCUT).toBe('No shortcut is active. Record one in Settings.');
    expect(screen.getAllByText(NO_SHORTCUT).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Hold the shortcut/)).toBeNull();
  });
});


describe('the main window tracks what registration left active', () => {
  beforeEach(() => resetActiveShortcut());

  it('a double failure broadcast marks nothing active; a later ok restores it', async () => {
    const { emitShortcutBound } = await import('../../src/services/shortcut/bindingEvents');
    const { getActiveShortcut } = await import('../../src/services/shortcut/activeShortcut');
    emitShortcutBound({ active: null, ok: false, previous: DEFAULT, shortcut: 'Ctrl + Alt + T' });
    expect(getActiveShortcut()).toBeNull();
    emitShortcutBound({ active: 'Alt + J', ok: true, shortcut: 'Alt + J' });
    expect(getActiveShortcut()).toBe('Alt + J');
  });
});
