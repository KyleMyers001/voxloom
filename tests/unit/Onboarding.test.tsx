import { dispatchPracticeGesture, subscribePracticeReset } from '../../src/features/onboarding/practiceBridge';
import { act } from '@testing-library/react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useApp } from '../../src/app/AppContext';
import { Onboarding } from '../../src/features/onboarding/Onboarding';
import type { SetupBoundary } from '../../src/features/onboarding/guidedSetup';
import { renderWithApp } from './testUtils';

export function setupBoundary(): SetupBoundary {
  return {
    native: true, query: vi.fn().mockResolvedValue({ microphone: 'authorized', accessibility: 'authorized' }),
    readiness: vi.fn(async (modelId) => ({ modelId, ready: true, reason: null })),
    request: vi.fn(), openSettings: vi.fn(), download: vi.fn(), cancelDownload: vi.fn(), activeShortcut: () => 'Ctrl + Shift + Space',
  };
}
const storage = () => ({ read: () => null, write: vi.fn() });

describe('B guided setup', () => {
  it('explicit Close cancels a pending practice start and closes, unlike Escape cancellation', async () => {
    const io = setupBoundary();
    const close = vi.fn();
    const user = userEvent.setup();
    renderWithApp(<Onboarding boundary={io} onClose={close} progressStorage={{ read: () => JSON.stringify({ version: 1, step: 3 }), write: vi.fn() }} />);
    await waitFor(() => expect(io.readiness).toHaveBeenCalled());
    io.readiness = () => new Promise(() => {});
    act(() => dispatchPracticeGesture('hold-start'));
    await user.click(screen.getByRole('button', { name: 'Set up later' }));
    expect(close).toHaveBeenCalledOnce();
  });
  it('a start refused by a failed recheck resets the gesture machine so no stray latch remains', async () => {
    const io = setupBoundary();
    renderWithApp(<Onboarding boundary={io} onClose={vi.fn()} progressStorage={{ read: () => JSON.stringify({ version: 1, step: 3 }), write: vi.fn() }} />);
    await waitFor(() => expect(io.readiness).toHaveBeenCalled());
    vi.mocked(io.query).mockResolvedValue({ microphone: 'authorized', accessibility: 'not-granted' });
    const reset = vi.fn();
    const unsubscribe = subscribePracticeReset(reset);
    try {
      act(() => dispatchPracticeGesture('hold-start'));
      await waitFor(() => expect(reset).toHaveBeenCalled());
      expect(screen.getByText(/Check permissions, voice pack and registered shortcut/)).toBeInTheDocument();
    } finally { unsubscribe(); }
  });
  it('discloses Base English before Start and Set up later leaves setup incomplete', async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    const io = setupBoundary();
    renderWithApp(<Onboarding boundary={io} onClose={close} progressStorage={storage()} />);
    expect(screen.getByRole('heading', { name: /Less typing/ })).toBeInTheDocument();
    expect(screen.getByText(/Starting setup downloads Whisper Base/)).toHaveTextContent('148 MB');
    expect(io.download).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Set up later' }));
    expect(close).toHaveBeenCalledOnce();
  });
  it('Skip setup marks setup complete from a later step without requiring practice', async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    function Complete() { return <output data-testid="complete">{String(useApp().state.onboarding.complete)}</output>; }
    renderWithApp(<><Onboarding boundary={setupBoundary()} onClose={close} progressStorage={{ read: () => JSON.stringify({ version: 1, step: 3 }), write: vi.fn() }} /><Complete /></>);
    expect(screen.getByTestId('complete')).toHaveTextContent('false');
    await user.click(screen.getByRole('button', { name: 'Skip setup' }));
    expect(close).toHaveBeenCalledOnce();
    expect(screen.getByTestId('complete')).toHaveTextContent('true');
  });
  it('requires only Microphone and Accessibility and a ready pack before the accepted shortcut and writable two-try note', async () => {
    const user = userEvent.setup();
    const io = setupBoundary();
    vi.mocked(io.query).mockResolvedValue({ microphone: 'authorized', accessibility: 'not-granted' });
    renderWithApp(<Onboarding boundary={io} onClose={vi.fn()} progressStorage={storage()} />);
    await user.click(screen.getByRole('button', { name: /Start setup/ }));
    expect(screen.getByRole('heading', { name: /A few permissions/ })).toBeInTheDocument();
    expect(screen.getByText(/Two permissions connect/)).toBeInTheDocument();
    expect(screen.queryByText(/Input Monitoring/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled();
    expect(screen.getByText(/Accessibility lets Voxloom insert words/)).toHaveTextContent(/Esc/);
    await user.click(screen.getByRole('button', { name: 'Open Accessibility Settings' }));
    expect(io.request).toHaveBeenCalledWith('accessibility');
    vi.mocked(io.query).mockResolvedValue({ microphone: 'authorized', accessibility: 'authorized' });
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Continue/ })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /Continue/ }));
    expect(screen.getByRole('heading', { name: /Your shortcut/ })).toBeInTheDocument();
    expect(screen.getByText(/press just one key/)).toHaveTextContent('Accessibility access you allowed in step 1');
    expect(screen.queryByText(/Input Monitoring/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Use this shortcut/ }));
    const note = screen.getByRole('textbox', { name: 'Practice dictation field' });
    expect(note).not.toHaveAttribute('readonly');
    expect(screen.getByRole('heading', { name: /First, hold/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try double-tap/ })).toBeDisabled();
    await user.type(note, 'Typing does not count.');
    expect(screen.getByRole('button', { name: /Try double-tap/ })).toBeDisabled();
    expect(screen.queryByText(/Simulate/)).not.toBeInTheDocument();
  });
  it('BUS-219: step 2 shows the shortcut once in a card, with no latch or raw-code wording', async () => {
    const user = userEvent.setup();
    renderWithApp(<Onboarding boundary={setupBoundary()} onClose={vi.fn()} progressStorage={{ read: () => JSON.stringify({ version: 1, step: 2 }), write: vi.fn() }} />);
    expect(screen.getByRole('heading', { name: /Your shortcut/ })).toBeInTheDocument();
    expect(screen.getByText('Hold these keys and talk, and Voxloom types your words where you’re writing. Keep them, or pick your own.')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Your shortcut Default' })).toBeInTheDocument();
    expect(screen.getAllByText('Control Shift Space')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Hold the keys while you talk. Let go when you’re done.');
    expect(screen.getByText('More ways to use it')).toBeInTheDocument();
    expect(screen.getByText('You can change this later in Settings.')).toBeInTheDocument();
    for (const gone of [/Global shortcut/, /Registered:/, /latch/i, /native binding/, /Reset to default/, /Prefer a single key/, /AltRight/]) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
    await waitFor(() => expect(screen.getByRole('button', { name: /Use this shortcut/ })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Change shortcut' }));
    expect(screen.getByRole('button', { name: 'Dictation shortcut, recording' })).toHaveFocus();
    await user.keyboard('{Escape}');
    // Esc ends recording; it must not close setup.
    expect(screen.getByRole('heading', { name: /Your shortcut/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change shortcut' })).toHaveFocus();
  });
});
