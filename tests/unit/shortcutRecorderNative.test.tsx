// BUS-47: in the app, the recorder waits for the main window's registration
// result before announcing, and never keeps a combo the OS refused.
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Payload = {
  active?: string | null; message?: string; ok: boolean; previous?: string | null; shortcut: string;
};
const bound = vi.hoisted(() => ({ handler: null as ((p: Payload) => void) | null }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('../../src/services/shortcut/bindingEvents', () => ({
  listenShortcutBound: async (h: (p: Payload) => void) => { bound.handler = h; return () => {}; },
}));

import { CONFIRM_TIMEOUT_MS, ShortcutRecorder } from '../../src/features/settings/ShortcutRecorder';

const DEFAULT = 'Ctrl + Shift + Space';
const field = () => screen.getByRole('button', { name: /^Dictation shortcut/ });
const status = () => screen.getByRole('status');

function Harness({ initial = DEFAULT, onChange }: { initial?: string; onChange: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <ShortcutRecorder
      defaultValue={DEFAULT}
      onChange={(next) => { setValue(next); onChange(next); }}
      value={value}
    />
  );
}

const report = (p: Payload) => act(async () => bound.handler!(p));

describe('ShortcutRecorder waits for native registration', () => {
  beforeEach(() => { bound.handler = null; });
  afterEach(() => vi.useRealTimers());

  it('rolls a refused combo back to the previous shortcut', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(field());
    await user.keyboard('{Control>}{Alt>}k{/Alt}{/Control}');
    expect(status()).toHaveTextContent(/^Setting/);
    await report({ message: 'raw Control+Alt+K', ok: false, shortcut: 'Ctrl + Alt + K' });
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT);
    expect(field()).toHaveAccessibleName('Dictation shortcut, Control Shift Space');
    expect(status()).toHaveTextContent('⌃⌥K is in use by another app. Kept ⌃⇧Space.');
    expect(status()).not.toHaveTextContent('Control+Alt+K'); // no raw hotkey string
  });

  it('announces success only after the main window confirms', async () => {
    render(<Harness onChange={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(field());
    await user.keyboard('{Control>}{Alt>}k{/Alt}{/Control}');
    await report({ ok: true, shortcut: 'Ctrl + Alt + K' });
    expect(status()).toHaveTextContent(/^Shortcut set to/);
  });

  it('Reset to default uses the same pending flow and rolls back on failure', async () => {
    const onChange = vi.fn();
    render(<Harness initial="Alt + J" onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reset to default' }));
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT);
    expect(status()).toHaveTextContent(/^Setting/);
    await report({ ok: false, shortcut: DEFAULT });
    expect(onChange).toHaveBeenLastCalledWith('Alt + J');
    expect(status()).toHaveTextContent('⌃⇧Space is in use by another app. Kept ⌥J.');
  });

  it('stops saying "Setting…" if no result arrives', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Harness onChange={vi.fn()} />);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(field());
    await user.keyboard('{Control>}{Alt>}k{/Alt}{/Control}');
    await act(async () => { vi.advanceTimersByTime(CONFIRM_TIMEOUT_MS + 1); });
    expect(status()).toHaveTextContent(/Still waiting for/);
    expect(status()).toHaveAttribute('role', 'status');
  });

  it('a late ok after the timeout replaces "Couldn\'t confirm" with success', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Harness onChange={vi.fn()} />);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(field());
    await user.keyboard('{Control>}{Alt>}k{/Alt}{/Control}');
    await act(async () => { vi.advanceTimersByTime(CONFIRM_TIMEOUT_MS + 1); });
    expect(status()).toHaveTextContent(/Still waiting for/);
    await report({ ok: true, shortcut: 'Ctrl + Alt + K' });
    expect(status()).toHaveTextContent(/^Shortcut set to/);
  });

  it('reverts to the last confirmed combo, not the last attempted one', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(field());
    await user.keyboard('{Control>}{Alt>}k{/Alt}{/Control}');
    await user.click(field());
    await user.keyboard('{Control>}{Alt>}j{/Alt}{/Control}');
    await report({ ok: false, shortcut: 'Ctrl + Alt + J' });
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT);
  });

  it('recording B keeps A\'s late ok as the revert target', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(field());
    await user.keyboard('{Control>}{Alt>}a{/Alt}{/Control}');
    await user.click(field());
    await user.keyboard('{Control>}{Alt>}b{/Alt}{/Control}');
    await report({ ok: true, shortcut: 'Ctrl + Alt + A' });
    await report({ ok: false, shortcut: 'Ctrl + Alt + B' }); // no active: own tracking
    expect(onChange).toHaveBeenLastCalledWith('Ctrl + Alt + A');
  });

  it('uses the main window\'s active combo as the revert target', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(field());
    await user.keyboard('{Control>}{Alt>}b{/Alt}{/Control}');
    await report({ active: 'Ctrl + Alt + A', ok: false, shortcut: 'Ctrl + Alt + B' });
    expect(onChange).toHaveBeenLastCalledWith('Ctrl + Alt + A');
  });

  it('a late refusal after the timeout still rolls back and says so', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(field());
    await user.keyboard('{Control>}{Alt>}k{/Alt}{/Control}');
    await act(async () => { vi.advanceTimersByTime(CONFIRM_TIMEOUT_MS + 1); });
    expect(status()).toHaveTextContent(/Still waiting for/);
    await report({ active: DEFAULT, ok: false, shortcut: 'Ctrl + Alt + K' });
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT);
    expect(field()).toHaveAccessibleName('Dictation shortcut, Control Shift Space');
    expect(status()).toHaveTextContent('⌃⌥K is in use by another app. Kept ⌃⇧Space.');
  });

  it('says so when the new combo is refused and restoring the old one fails too', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(field());
    await user.keyboard('{Control>}{Alt>}t{/Alt}{/Control}');
    await report({ active: null, ok: false, previous: DEFAULT, shortcut: 'Ctrl + Alt + T' });
    expect(status()).toHaveTextContent(
      'Couldn\'t set ⌃⌥T or restore ⌃⇧Space. No shortcut is active. Record one.',
    );
    expect(status()).not.toHaveTextContent('kept');
    // settings.json never keeps the refused combo; next launch retries the old one.
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT);
  });

  it('a refusal that lands while the combo is being saved is not overwritten by "Setting…"', async () => {
    let refuse = true;
    function Racy() {
      const [value, setValue] = useState(DEFAULT);
      return (
        <ShortcutRecorder
          defaultValue={DEFAULT}
          onChange={(next) => {
            setValue(next);
            if (refuse && next === 'Ctrl + Alt + K') {
              refuse = false;
              bound.handler!({ active: DEFAULT, ok: false, shortcut: next });
            }
          }}
          value={value}
        />
      );
    }
    render(<Racy />);
    const user = userEvent.setup();
    await user.click(field());
    await user.keyboard('{Control>}{Alt>}k{/Alt}{/Control}');
    expect(status()).toHaveTextContent('⌃⌥K is in use by another app. Kept ⌃⇧Space.');
  });

  it('uses the final copy for pending, success and timeout', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Harness onChange={vi.fn()} />);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(field());
    await user.keyboard('{Control>}{Alt>}k{/Alt}{/Control}');
    expect(status()).toHaveTextContent('Setting ⌃⌥K…');
    await act(async () => { vi.advanceTimersByTime(CONFIRM_TIMEOUT_MS + 1); });
    expect(status()).toHaveTextContent('Still waiting for ⌃⌥K. Try it, or record again.');
    await report({ ok: true, shortcut: 'Ctrl + Alt + K' });
    expect(status()).toHaveTextContent('Shortcut set to ⌃⌥K.');
  });
});
