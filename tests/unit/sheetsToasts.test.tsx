/// UI PR 9: step dots, shortcuts sheet, toast severity icons.
import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ShortcutsDialog } from '../../src/app/AppDialogs';
import { useToastMessages } from '../../src/app/useToastMessages';
import { Toast, toastTone } from '../../src/components/Toast';
import { StepDots } from '../../src/features/onboarding/StepDots';
import { SUPERSEDED_DELIVERY_MESSAGE } from '../../src/services/delivery';

describe('toastTone (toasts board strings)', () => {
  it.each([
    ['Copied to clipboard', 'ok'],
    ['Inserted into Notes', 'ok'],
    ['May have been inserted — also copied', 'warn'],
    ['Text sent to Terminal — input not verified. Inspect before retrying.', 'warn'],
    ['Copy failed', 'err'],
    ['Failed to read history store: unexpected token', 'err'],
    ['Finish the current dictation before retrying', 'err'],
    ['Recovery buffer expired', 'err'],
    ['Shortcut “Ctrl + Space” is in use; kept Ctrl + Shift + Space', 'err'],
    ['Escape-cancel is off: Voxloom does not have Accessibility permission. Dictation still works.', 'warn'],
    // BUS-91: neutral info icon, never the error style.
    [SUPERSEDED_DELIVERY_MESSAGE, 'warn'],
  ])('%s → %s', (message, tone) => expect(toastTone(message)).toBe(tone));

  it('renders an icon by severity and an explicit tone wins', () => {
    const { container, rerender } = render(<Toast message="Copied to clipboard" />);
    expect(container.querySelector('.toast')).toHaveClass('t-ok', 'visible');
    expect(container.querySelector('.toast svg')).not.toBeNull();
    rerender(<Toast message="Something odd" tone="err" />);
    expect(container.querySelector('.toast')).toHaveClass('t-err');
    rerender(<Toast message="" />);
    expect(container.querySelector('.toast svg')).toBeNull();
    expect(container.querySelector('.toast')).not.toHaveClass('visible');
  });
});

describe('StepDots', () => {
  it('fills dots up to the current step and reads "Step n of 3"', () => {
    const { container } = render(<StepDots step={2} />);
    expect(container.querySelectorAll('.steps span.on')).toHaveLength(2);
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument();
  });
});

describe('ShortcutsDialog', () => {
  it('lists gesture, navigation, Settings and this sheet, and Done closes it', async () => {
    const onClose = vi.fn();
    render(<ShortcutsDialog onClose={onClose} opener={null} shortcut="Control+Shift+Space" />);
    for (const label of ['Dictate (hold / double-tap to latch)', 'Go to Home · History · Dictionary', 'Settings', 'Show this sheet']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    await userEvent.setup().click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('review #45 nits', () => {
  it('reads "Error:" before error toasts (visually hidden)', () => {
    const { container, rerender } = render(<Toast message="Copy failed" />);
    expect(container.querySelector('.toast .sr-only')).toHaveTextContent('Error:');
    expect(container.querySelector('.toast')).toHaveTextContent('Error: Copy failed');
    rerender(<Toast message="Copied to clipboard" />);
    expect(container.querySelector('.toast .sr-only')).toBeNull();
  });

  it('shows "Alt" instead of ⌥ off macOS in the Shortcuts sheet', () => {
    const spy = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    const { unmount } = render(<ShortcutsDialog onClose={() => {}} opener={null} shortcut="Control+Shift+Space" />);
    const caps = [...document.body.querySelectorAll('.key-combo__caps .kbd')].map((k) => k.textContent);
    expect(caps).toContain('Alt');
    expect(caps).not.toContain('⌥');
    unmount();
    spy.mockReturnValue('MacIntel');
    render(<ShortcutsDialog onClose={() => {}} opener={null} shortcut="Control+Shift+Space" />);
    expect([...document.body.querySelectorAll('.key-combo__caps .kbd')].map((k) => k.textContent)).toContain('⌥');
    spy.mockRestore();
  });

  it('a newer toast is not hidden by the older toast’s timer', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToastMessages([]));
    act(() => result.current.announce('first'));
    act(() => { vi.advanceTimersByTime(1_000); });
    act(() => result.current.announce('second'));
    act(() => { vi.advanceTimersByTime(1_000); }); // first's 1.8 s timer would have fired here
    expect(result.current.toast).toBe('second');
    act(() => { vi.advanceTimersByTime(800); });
    expect(result.current.toast).toBe('');
    vi.useRealTimers();
  });
});
