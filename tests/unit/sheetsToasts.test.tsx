/// UI PR 9: step dots, shortcuts sheet, toast severity icons.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ShortcutsDialog } from '../../src/app/AppDialogs';
import { Toast, toastTone } from '../../src/components/Toast';
import { StepDots } from '../../src/features/onboarding/StepDots';

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
