// BUS-219: the setup card's wording for native registration results.
import { act, fireEvent, screen } from '@testing-library/react';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Payload = { active?: string | null; ok: boolean; previous?: string | null; shortcut: string };
const bound = vi.hoisted(() => ({ handler: null as ((p: Payload) => void) | null }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('../../src/services/shortcut/bindingEvents', () => ({
  emitShortcutRetry: () => {},
  listenShortcutBound: async (h: (p: Payload) => void) => { bound.handler = h; return () => {}; },
  queryShortcutBound: () => {},
}));

import { ShortcutRecorder } from '../../src/features/settings/ShortcutRecorder';
import { resetRecorderStore } from '../../src/features/settings/recorderStore';
import { resetActiveShortcut } from '../../src/services/shortcut/activeShortcut';

const DEFAULT = 'Ctrl + Shift + Space';
function Card({ initial = DEFAULT, onChange }: { initial?: string; onChange: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return <ShortcutRecorder defaultValue={DEFAULT} id="onboarding-shortcut" onChange={(next) => { setValue(next); onChange(next); }} value={value} variant="card" />;
}
const report = (p: Payload) => act(async () => bound.handler!(p));
const message = () => screen.getByRole('status');

describe('setup shortcut card, native results', () => {
  beforeEach(() => { bound.handler = null; resetRecorderStore(); resetActiveShortcut(); });

  it('shows "Setting…", then "Saved" once the OS confirms', async () => {
    render(<Card onChange={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Change shortcut' }));
    await user.keyboard('{Control>}{Alt>}k{/Alt}{/Control}');
    expect(message()).toHaveTextContent('Setting ⌃⌥K…');
    await report({ ok: true, shortcut: 'Ctrl + Alt + K' });
    expect(message()).toHaveTextContent('✓Saved. On the next step, hold ⌃⌥K to try it.');
  });

  it('a conflict keeps the current shortcut and says so in plain words', async () => {
    const onChange = vi.fn();
    render(<Card onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Change shortcut' }));
    await user.keyboard('{Alt>}{Meta>}d{/Meta}{/Alt}');
    await report({ ok: false, shortcut: 'Alt + Meta + D' });
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT);
    expect(screen.getByRole('group')).toHaveAccessibleName('Your shortcut Default');
    expect(screen.getByRole('group')).toHaveAttribute('data-state', 'error');
    expect(message()).toHaveTextContent('Another app already uses ⌥⌘D, so we kept your current shortcut, ⌃⇧Space. Try different keys.');
    expect(screen.getByRole('button', { name: 'Change shortcut' })).toHaveAttribute('aria-invalid', 'true');
  });

  it('with nothing active it says no shortcut is set and offers the default', async () => {
    render(<Card onChange={vi.fn()} />);
    const user = userEvent.setup();
    await report({ active: null, ok: false, shortcut: DEFAULT });
    await user.click(screen.getByRole('button', { name: 'Change shortcut' }));
    await user.keyboard('{Alt>}{Meta>}d{/Meta}{/Alt}');
    await report({ active: null, ok: false, previous: null, shortcut: 'Alt + Meta + D' });
    expect(message()).toHaveTextContent('⌥⌘D didn’t work, and no shortcut is set right now. Try different keys, or go back to the default.');
    expect(screen.getByRole('group')).toHaveTextContent('⌥⌘D');
    expect(screen.getByText(/, not active/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go back to the default (⌃ ⇧ Space)' })).toBeInTheDocument();
  });

  it('A-none after a refused launch default: shows the attempted keys, keeps the default saved, offers the link', async () => {
    const onChange = vi.fn();
    render(<Card onChange={onChange} />);
    const user = userEvent.setup();
    await report({ active: null, ok: false, shortcut: DEFAULT }); // refused at launch
    await user.click(screen.getByRole('button', { name: 'Change shortcut' }));
    await user.keyboard('{Alt>}{Meta>}d{/Meta}{/Alt}');
    await report({ active: null, ok: false, previous: DEFAULT, shortcut: 'Alt + Meta + D' });
    // What's saved is unchanged by the card: the default stays saved for the next launch.
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT);
    const card = screen.getByRole('group');
    expect(card).toHaveAccessibleName('Your shortcut');
    expect(card).toHaveTextContent('⌥⌘D');
    expect(card).not.toHaveTextContent('⌃⇧Space');
    expect(screen.getByText('Option Command D')).toBeInTheDocument();
    expect(message()).toHaveTextContent('⌥⌘D didn’t work, and no shortcut is set right now. Try different keys, or go back to the default.');
    expect(screen.getByRole('button', { name: 'Go back to the default (⌃ ⇧ Space)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change shortcut' })).toHaveAccessibleDescription(/didn’t work/);
  });

  it('A-none with a non-default previous shortcut: same, and the previous one stays saved', async () => {
    const onChange = vi.fn();
    render(<Card initial="Ctrl + Alt + K" onChange={onChange} />);
    const user = userEvent.setup();
    await report({ active: null, ok: false, shortcut: 'Ctrl + Alt + K' });
    await user.click(screen.getByRole('button', { name: 'Change shortcut' }));
    await user.keyboard('{Alt>}{Meta>}d{/Meta}{/Alt}');
    await report({ active: null, ok: false, previous: 'Ctrl + Alt + K', shortcut: 'Alt + Meta + D' });
    expect(onChange).toHaveBeenLastCalledWith('Ctrl + Alt + K');
    expect(screen.getByRole('group')).toHaveTextContent('⌥⌘D');
    expect(message()).toHaveTextContent('⌥⌘D didn’t work, and no shortcut is set right now. Try different keys, or go back to the default.');
    expect(screen.getByRole('button', { name: 'Go back to the default (⌃ ⇧ Space)' })).toBeInTheDocument();
  });

  it('when the default itself is what failed, the line promises no link', async () => {
    render(<Card onChange={vi.fn()} />);
    const user = userEvent.setup();
    await report({ active: null, ok: false, shortcut: DEFAULT }); // refused at launch
    await user.click(screen.getByRole('button', { name: 'Change shortcut' }));
    await user.keyboard('{Control>}{Shift>}{ }{/Shift}{/Control}'); // re-record the default: a retry
    await report({ active: null, ok: false, previous: null, shortcut: DEFAULT });
    expect(screen.getByRole('group')).toHaveAccessibleName('Your shortcut Default');
    expect(message()).toHaveTextContent('⌃⇧Space didn’t work, and no shortcut is set right now. Try different keys.');
    expect(message()).not.toHaveTextContent('go back to the default');
    expect(screen.queryByRole('button', { name: /Go back to the default/ })).not.toBeInTheDocument();
  });

  it('a lone key with nothing active keeps the Accessibility reason (Settings wording)', async () => {
    render(<Card onChange={vi.fn()} />);
    const user = userEvent.setup();
    await report({ active: null, ok: false, shortcut: DEFAULT });
    await user.click(screen.getByRole('button', { name: 'Change shortcut' }));
    act(() => { fireEvent.keyDown(window, { code: 'AltRight', key: 'Alt', altKey: true }); });
    act(() => { fireEvent.keyUp(window, { code: 'AltRight', key: 'Alt' }); });
    await report({ active: null, ok: false, previous: DEFAULT, shortcut: 'AltRight' });
    expect(message()).toHaveTextContent('⌥ (right) needs Accessibility. Allow Voxloom in System Settings › Privacy & Security › Accessibility. No shortcut is active. Record one.');
    expect(message()).not.toHaveTextContent('didn’t work');
  });

  it('off macOS a lone key with nothing active says it only works on macOS', async () => {
    const platform = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
    Object.defineProperty(window.navigator, 'platform', { configurable: true, get: () => 'Linux x86_64' });
    try {
      render(<Card onChange={vi.fn()} />);
      const user = userEvent.setup();
      await report({ active: null, ok: false, shortcut: DEFAULT });
      await user.click(screen.getByRole('button', { name: 'Change shortcut' }));
      act(() => { fireEvent.keyDown(window, { code: 'AltRight', key: 'Alt', altKey: true }); });
      act(() => { fireEvent.keyUp(window, { code: 'AltRight', key: 'Alt' }); });
      await report({ active: null, ok: false, previous: DEFAULT, shortcut: 'AltRight' });
      expect(message()).toHaveTextContent('Alt (right) on its own only works on macOS. No shortcut is active. Record one.');
    } finally {
      if (platform) Object.defineProperty(window.navigator, 'platform', platform);
    }
  });
});
