// BUS-47: in the app, the recorder waits for the main window's registration
// result before announcing, and never keeps a combo the OS refused.
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Payload = {
  active?: string | null; message?: string; ok: boolean; previous?: string | null; shortcut: string;
};
const bound = vi.hoisted(() => ({ handler: null as ((p: Payload) => void) | null }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
const retries = vi.hoisted(() => [] as string[]);
vi.mock('../../src/services/shortcut/bindingEvents', () => ({
  emitShortcutRetry: (shortcut: string) => { retries.push(shortcut); },
  listenShortcutBound: async (h: (p: Payload) => void) => { bound.handler = h; return () => {}; },
  queryShortcutBound: () => {},
}));

import { CONFIRM_TIMEOUT_MS, ShortcutRecorder } from '../../src/features/settings/ShortcutRecorder';
import { resetRecorderStore } from '../../src/features/settings/recorderStore';
import { resetActiveShortcut } from '../../src/services/shortcut/activeShortcut';

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
  beforeEach(() => { bound.handler = null; retries.length = 0; resetRecorderStore(); resetActiveShortcut(); });
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

  it('a refused lone key rolls back and says why, in words', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(field());
    act(() => { fireEvent.keyDown(window, { code: 'F13', key: 'F13' }); });
    expect(onChange).toHaveBeenLastCalledWith('F13');
    await report({ message: 'Accessibility permission is needed', ok: false, shortcut: 'F13' });
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT);
    expect(status()).toHaveTextContent(/^F13 (needs Accessibility\. Allow Voxloom in System Settings › Privacy & Security › Accessibility\. Then record it again; relaunch Voxloom if that doesn't help|on its own only works on macOS)\. Kept /);
    expect(status()).not.toHaveTextContent('Permission is needed'); // never the raw error
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

  it('BUS-74: a failed re-bind after re-recording the same combo replaces "Shortcut set to"', async () => {
    render(<Harness onChange={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(field());
    await user.keyboard('{Control>}{Shift>} {/Shift}{/Control}');
    expect(status()).toHaveTextContent('Shortcut set to ⌃⇧Space.');
    await report({ active: null, message: 'taken', ok: false, previous: DEFAULT, shortcut: DEFAULT });
    expect(status()).toHaveTextContent('Couldn\'t set ⌃⇧Space. No shortcut is active. Record one.');
  });

  it('re-saving the saved shortcut while nothing is active asks main to bind it again', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await report({ active: null, ok: false, shortcut: DEFAULT }); // refused launch: saved, not active
    const user = userEvent.setup();
    await user.click(field());
    await user.keyboard('{Control>}{Shift>} {/Shift}{/Control}');
    expect(retries).toEqual([DEFAULT]);
    expect(onChange).not.toHaveBeenCalled(); // the value can't change
    expect(status()).toHaveTextContent('Setting ⌃⇧Space…'); // not "Shortcut set" before main says so
    await report({ active: DEFAULT, ok: true, shortcut: DEFAULT });
    expect(status()).toHaveTextContent('Shortcut set to ⌃⇧Space.');
  });

  it('a failed retry says why instead of claiming success', async () => {
    render(<Harness initial="F13" onChange={vi.fn()} />);
    await report({ active: null, ok: false, shortcut: 'F13' });
    const user = userEvent.setup();
    await user.click(field());
    act(() => { fireEvent.keyDown(window, { code: 'F13', key: 'F13' }); });
    expect(retries).toEqual(['F13']);
    await report({ active: null, message: 'Accessibility permission is needed', ok: false, shortcut: 'F13' });
    expect(status()).toHaveTextContent(/^F13 (needs Accessibility|on its own only works on macOS)/);
    expect(status()).toHaveTextContent('No shortcut is active.');
  });

  it('re-saving the saved shortcut while it IS active does not ask again', async () => {
    render(<Harness onChange={vi.fn()} />);
    await report({ active: DEFAULT, ok: true, shortcut: DEFAULT });
    const user = userEvent.setup();
    await user.click(field());
    await user.keyboard('{Control>}{Shift>} {/Shift}{/Control}');
    expect(retries).toEqual([]);
    expect(status()).toHaveTextContent('Shortcut set to ⌃⇧Space.');
  });
});
