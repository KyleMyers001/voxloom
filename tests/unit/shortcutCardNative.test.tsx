// BUS-219: the setup card's wording for native registration results.
import { act, screen } from '@testing-library/react';
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
function Card({ onChange }: { onChange: (v: string) => void }) {
  const [value, setValue] = useState(DEFAULT);
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
});
