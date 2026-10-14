// BUS-47 QA s5 + s7: the registration result outlives the recorder (tab
// switches remount it), and "no shortcut active" reaches every surface.
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Payload = {
  active?: string | null; ok: boolean; previous?: string | null; replay?: boolean; shortcut: string;
};
const bound = vi.hoisted(() => ({ handler: null as ((p: Payload) => void) | null, queries: 0 }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('../../src/services/shortcut/bindingEvents', () => ({
  listenShortcutBound: async (h: (p: Payload) => void) => { bound.handler = h; return () => {}; },
  queryShortcutBound: () => { bound.queries += 1; },
}));

import { ShortcutRecorder } from '../../src/features/settings/ShortcutRecorder';
import { resetRecorderStore } from '../../src/features/settings/recorderStore';
import { resetActiveShortcut } from '../../src/services/shortcut/activeShortcut';
import { captureShortcut } from '../../src/services/shortcut/shortcutCapture';

const DEFAULT = 'Ctrl + Shift + Space';
const field = () => screen.getByRole('button', { name: /^Dictation shortcut/ });
const status = () => screen.getByRole('status');
const report = (p: Payload) => act(async () => bound.handler!(p));

/** Settings with a tab toggle: hiding the tab unmounts the recorder. */
function Tabs({ onChange }: { onChange: (v: string) => void }) {
  const [value, setValue] = useState(DEFAULT);
  const [shown, setShown] = useState(true);
  return <>
    <button onClick={() => setShown((s) => !s)} type="button">toggle tab</button>
    {shown && (
      <ShortcutRecorder
        defaultValue={DEFAULT}
        onChange={(next) => { setValue(next); onChange(next); }}
        value={value}
      />
    )}
  </>;
}

describe('recorder state outlives the recorder', () => {
  beforeEach(() => { bound.handler = null; bound.queries = 0; resetRecorderStore(); resetActiveShortcut(); });

  it('shows a refusal that lands while the recorder is unmounted (tab switch)', async () => {
    const onChange = vi.fn();
    render(<Tabs onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(field());
    await user.keyboard('{Control>}{Alt>}k{/Alt}{/Control}');
    expect(status()).toHaveTextContent('Setting ⌃⌥K…');
    const toggle = screen.getByRole('button', { name: 'toggle tab' });
    await user.click(toggle); // leave the tab
    await report({ active: DEFAULT, ok: false, previous: DEFAULT, shortcut: 'Ctrl + Alt + K' });
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT); // reverted while unmounted
    await user.click(toggle); // come back
    expect(status()).toHaveTextContent('⌃⌥K is in use by another app. Kept ⌃⇧Space.');
    expect(field()).toHaveAccessibleName('Dictation shortcut, Control Shift Space');
  });

  it('a refusal right after the remount still lands', async () => {
    render(<Tabs onChange={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(field());
    await user.keyboard('{Control>}{Alt>}k{/Alt}{/Control}');
    const toggle = screen.getByRole('button', { name: 'toggle tab' });
    await user.click(toggle);
    await user.click(toggle);
    expect(status()).toHaveTextContent('Setting ⌃⌥K…');
    await report({ active: DEFAULT, ok: false, shortcut: 'Ctrl + Alt + K' });
    expect(status()).toHaveTextContent('⌃⌥K is in use by another app. Kept ⌃⇧Space.');
  });

  it('asks the main window for the last result once', async () => {
    render(<Tabs onChange={vi.fn()} />);
    await act(async () => {});
    expect(bound.queries).toBe(1);
  });

  it('after a double failure the field is marked not active, with a matching label', async () => {
    const onChange = vi.fn();
    render(<Tabs onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(field());
    await user.keyboard('{Control>}{Alt>}t{/Alt}{/Control}');
    await report({ active: null, ok: false, previous: DEFAULT, shortcut: 'Ctrl + Alt + T' });
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT); // kept so next launch retries
    expect(field()).toHaveAccessibleName('Dictation shortcut, Control Shift Space, not active');
    expect(field()).toHaveAttribute('data-inactive', 'true');
    expect(field()).toHaveTextContent('(not active)');
    await report({ active: 'Ctrl + Alt + J', ok: true, shortcut: 'Ctrl + Alt + J' });
    expect(field()).not.toHaveAttribute('data-inactive');
  });

  it('a replayed result updates "not active" but never the status line', async () => {
    render(<Tabs onChange={vi.fn()} />);
    await act(async () => {});
    await report({ active: null, ok: false, replay: true, shortcut: DEFAULT });
    expect(field()).toHaveTextContent('(not active)');
    expect(status()).toHaveTextContent('');
  });
});

describe('reserved combos are macOS-only', () => {
  const ev = (mods: Partial<KeyboardEvent>) => ({
    altKey: false, code: 'Space', ctrlKey: false, key: ' ', metaKey: false, shiftKey: false, ...mods,
  }) as KeyboardEvent;

  it('blocks ⌘Space on Mac but lets Super+Space through elsewhere', () => {
    expect(captureShortcut(ev({ metaKey: true }), true)).toMatchObject({ invalid: { reason: 'reserved' } });
    expect(captureShortcut(ev({ metaKey: true }), false)).toEqual({ combo: 'Meta + Space', kind: 'captured' });
    expect(captureShortcut(ev({ ctrlKey: true, metaKey: true }), false).kind).toBe('captured');
  });
});
