// BUS-47: the global shortcut can't start dictation while a recorder records.
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShortcutRecorder } from '../../src/features/settings/ShortcutRecorder';
import { resetRecorderStore } from '../../src/features/settings/recorderStore';
import {
  applyRemoteLease, beginRecordingSuspend, isDictationSuspended, LEASE_MS, resetRecordingSuspend, suspendable,
} from '../../src/services/shortcut/recordingSuspend';

const DEFAULT = 'Ctrl + Shift + Space';
function Harness() {
  const [value, setValue] = useState(DEFAULT);
  return <ShortcutRecorder defaultValue={DEFAULT} onChange={setValue} value={value} />;
}
const field = () => screen.getByRole('button', { name: /^Dictation shortcut/ });

afterEach(() => {
  resetRecordingSuspend();
  resetRecorderStore();
});

describe('suspendable gesture handler', () => {
  it('drops starts while suspended, and the paired finish', () => {
    const handler = vi.fn();
    let on = true;
    const wrapped = suspendable(handler, () => on);
    wrapped('hold-start');
    on = false;
    wrapped('hold-finish');
    expect(handler).not.toHaveBeenCalled();
    wrapped('hold-start');
    wrapped('hold-finish');
    expect(handler.mock.calls.map((c) => c[0])).toEqual(['hold-start', 'hold-finish']);
  });

  it('lets a run that began before recording finish', () => {
    const handler = vi.fn();
    let on = false;
    const wrapped = suspendable(handler, () => on);
    wrapped('latch-start');
    on = true;
    wrapped('latch-finish');
    expect(handler.mock.calls.map((c) => c[0])).toEqual(['latch-start', 'latch-finish']);
  });

  it('the end function is idempotent and never underflows', () => {
    const end = beginRecordingSuspend();
    expect(isDictationSuspended()).toBe(true);
    end();
    end();
    expect(isDictationSuspended()).toBe(false);
    const end2 = beginRecordingSuspend();
    expect(isDictationSuspended()).toBe(true);
    end2();
    expect(isDictationSuspended()).toBe(false);
  });
});

describe('ShortcutRecorder suspends dictation only while recording', () => {
  it('suspends on start and restores after Esc cancel', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    expect(isDictationSuspended()).toBe(false);
    await user.click(field());
    expect(isDictationSuspended()).toBe(true);
    await user.keyboard('{Escape}');
    expect(isDictationSuspended()).toBe(false);
  });

  it('restores after save', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(field());
    await user.keyboard('{Control>}{Alt>}k{/Alt}{/Control}');
    expect(field()).toHaveAttribute('aria-pressed', 'false');
    expect(isDictationSuspended()).toBe(false);
  });

  it('restores after blur and after unmount', async () => {
    const { unmount } = render(<><Harness /><button type="button">elsewhere</button></>);
    const user = userEvent.setup();
    await user.click(field());
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(isDictationSuspended()).toBe(false);
    await user.click(field());
    expect(isDictationSuspended()).toBe(true);
    unmount();
    expect(isDictationSuspended()).toBe(false);
  });

  it('restores on page hide (window closing)', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(field());
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(isDictationSuspended()).toBe(false);
  });

  it('Esc pressed with focus elsewhere in the window still cancels', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(field());
    act(() => { (document.activeElement as HTMLElement | null)?.blur?.(); });
    // Blur cancels too; start again and dispatch Esc on the body directly.
    await user.click(field());
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, code: 'Escape', key: 'Escape' }));
    });
    expect(field()).toHaveAttribute('aria-pressed', 'false');
    expect(field()).toHaveAccessibleName('Dictation shortcut, Control Shift Space');
    expect(screen.getByRole('status')).toHaveTextContent('Canceled. Shortcut unchanged.');
    expect(isDictationSuspended()).toBe(false);
  });

  it('Esc is never accepted as a combo, even with modifiers', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(field());
    await user.keyboard('{Control>}{Escape}{/Control}');
    expect(field()).toHaveAccessibleName('Dictation shortcut, Control Shift Space');
  });
});

describe('per-window leases', () => {
  it('one window\'s \'off\' doesn\'t unprotect another', () => {
    applyRemoteLease({ on: true, source: 'settings' }, 0);
    applyRemoteLease({ on: true, source: 'main' }, 0);
    applyRemoteLease({ on: false, source: 'settings' }, 1);
    expect(isDictationSuspended(2)).toBe(true);
    applyRemoteLease({ on: false, source: 'main' }, 3);
    expect(isDictationSuspended(4)).toBe(false);
  });

  it('a lease never ended still expires after LEASE_MS', () => {
    applyRemoteLease({ on: true, source: 'crashed' }, 0);
    expect(isDictationSuspended(LEASE_MS - 1)).toBe(true);
    expect(isDictationSuspended(LEASE_MS)).toBe(false);
  });
});
