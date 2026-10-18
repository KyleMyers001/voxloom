import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Home } from '../../src/features/home/Home';
import type { UseDogfoodCaptureResult } from
  '../../src/services/stt/useDogfoodCapture';
import { renderWithApp } from './testUtils';

function stubDogfood(
  overrides: Partial<UseDogfoodCaptureResult> = {},
): UseDogfoodCaptureResult {
  return {
    cancel: vi.fn(),
    captureState: { kind: 'idle' },
    hudResult: null,
    intendedTarget: null,
    message: null,
    origin: null,
    phase: 'idle',
    scopeReady: false,
    hudReady: false,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    transcript: null,
    ...overrides,
  };
}

describe('Home', () => {
  it('limits recent rows and reports copy success', async () => {
    const user = userEvent.setup();
    const toast = vi.fn();
    renderWithApp(<Home dogfood={stubDogfood()} onToast={toast} />);
    expect(screen.getAllByRole('button', { name: 'Copy dictation' }))
      .toHaveLength(5);
    expect(screen.getAllByText(/AM|PM/)).toHaveLength(5);
    await user.click(screen.getAllByRole('button', {
      name: 'Copy dictation',
    })[0]);
    expect(toast).toHaveBeenCalledWith('Copied to clipboard');
  });

  it('reports injected clipboard failure', async () => {
    const user = userEvent.setup();
    const toast = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    renderWithApp(<Home dogfood={stubDogfood()} onToast={toast} />);
    await user.click(screen.getAllByRole('button', {
      name: 'Copy dictation',
    })[0]);
    expect(toast).toHaveBeenCalledWith('Copy failed');
  });

  it.each([
    ['cleaning', 'Cleaning up locally…'], ['delivering', 'Delivering…'],
  ] as const)('shows %s as busy without offering another Home start', (phase, message) => {
    renderWithApp(<Home dogfood={stubDogfood({ phase })} onToast={vi.fn()} />);
    expect(screen.getByText(message)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Start capture' })).not.toBeInTheDocument();
  });

  it('shows the Dictate capture panel on Home', () => {
    renderWithApp(<Home dogfood={stubDogfood()} onToast={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Dictate' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start capture' })).toBeDisabled();
    expect(screen.getByText(/Native capture requires the Tauri shell/i))
      .toBeInTheDocument();
  });
});
