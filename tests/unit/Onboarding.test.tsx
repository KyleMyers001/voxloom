import { dispatchPracticeGesture, subscribePracticeReset } from '../../src/features/onboarding/practiceBridge';
import { act } from '@testing-library/react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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
  describe('BUS-224: expected voice-pack state on Welcome', () => {
    const missingReason = 'The selected voice pack is missing, downloading or not verified. Check or retry the download.';
    function missingBoundary(status: 'missing' | 'pending' | 'downloading' = 'missing') {
      const io = setupBoundary();
      io.readiness = vi.fn(async (modelId) => ({ modelId, ready: false, status, reason: missingReason }));
      return io;
    }
    it.each(['missing', 'pending', 'downloading'] as const)('step 0 shows no red reason for a %s voice pack, and no Skip setup', async (status) => {
      const io = missingBoundary(status);
      renderWithApp(<Onboarding boundary={io} onClose={vi.fn()} progressStorage={storage()} />);
      await waitFor(() => expect(io.readiness).toHaveBeenCalled());
      await act(async () => {});
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByText(missingReason)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Set up later' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Skip setup' })).not.toBeInTheDocument();
    });
    it('step 1 still shows the reason next to the voice-pack panel', async () => {
      renderWithApp(<Onboarding boundary={missingBoundary()} onClose={vi.fn()} progressStorage={{ read: () => JSON.stringify({ version: 1, step: 1 }), write: vi.fn() }} />);
      expect(await screen.findByRole('alert')).toHaveTextContent(missingReason);
      expect(screen.getByText('Voice pack needs attention')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry download' })).toBeInTheDocument();
    });
    it('Start setup surfaces the reason once setup has started, and Back to Welcome hides it again', async () => {
      const user = userEvent.setup();
      const io = missingBoundary();
      vi.mocked(io.download).mockRejectedValue(new Error('disk full'));
      renderWithApp(<Onboarding boundary={io} onClose={vi.fn()} progressStorage={storage()} />);
      await waitFor(() => expect(io.readiness).toHaveBeenCalled());
      await user.click(screen.getByRole('button', { name: /Start setup/ }));
      // A failed download is a real failure and stays visible, on step 1 and back on Welcome.
      expect(await screen.findByRole('alert')).toHaveTextContent(/Download failed: Error: disk full/);
      await user.click(screen.getByRole('button', { name: 'Back' }));
      expect(screen.getByRole('heading', { name: /Less typing/ })).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent(/Download failed/);
    });
    it('Back to Welcome hides only the expected readiness reason', async () => {
      const user = userEvent.setup();
      renderWithApp(<Onboarding boundary={missingBoundary()} onClose={vi.fn()} progressStorage={{ read: () => JSON.stringify({ version: 1, step: 1 }), write: vi.fn() }} />);
      expect(await screen.findByRole('alert')).toHaveTextContent(missingReason);
      await user.click(screen.getByRole('button', { name: 'Back' }));
      expect(screen.getByRole('heading', { name: /Less typing/ })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    it('step 0 still shows an unavailable engine and a failed check', async () => {
      const io = setupBoundary();
      io.readiness = vi.fn(async (modelId) => ({ modelId, ready: false, status: 'unavailable' as const, reason: 'The selected speech engine is unavailable in this build or on this Mac.' }));
      const view = renderWithApp(<Onboarding boundary={io} onClose={vi.fn()} progressStorage={storage()} />);
      expect(await screen.findByRole('alert')).toHaveTextContent(/speech engine is unavailable/);
      view.unmount();
      const failing = setupBoundary();
      failing.readiness = vi.fn().mockRejectedValue(new Error('readiness exploded'));
      renderWithApp(<Onboarding boundary={failing} onClose={vi.fn()} progressStorage={storage()} />);
      expect(await screen.findByRole('alert')).toHaveTextContent(/readiness exploded/);
    });
    it('step 0 still shows a progress save failure', async () => {
      const io = missingBoundary();
      renderWithApp(<Onboarding boundary={io} onClose={vi.fn()} progressStorage={{ read: () => null, write: () => { throw new Error('quota'); } }} />);
      expect(await screen.findByRole('alert')).toHaveTextContent(/Setup progress could not be saved/);
    });
  });
  describe('BUS-225: finish step', () => {
    const finished = () => ({ read: () => JSON.stringify({ version: 1, step: 4, holdDone: true, tapDone: true, mode: 'tap', modelId: 'whisper-base.en', shortcut: 'Ctrl + Shift + Space' }), write: vi.fn() });
    it('ready: new intro and note, no summary list or attention line, and only Back and Open Voxloom in the footer', async () => {
      const io = setupBoundary();
      renderWithApp(<Onboarding boundary={io} onClose={vi.fn()} progressStorage={finished()} />);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Open Voxloom' })).toBeEnabled());
      expect(screen.getByText('You’ve tried both ways to dictate. Choose Open Voxloom to finish, then use your shortcut in any app.')).toBeInTheDocument();
      expect(screen.getByText('Your shortcut works in other apps once setup closes. If an app won’t take typed text, Voxloom may copy your words so you can paste them.')).toBeInTheDocument();
      expect(document.querySelector('.guided-list')).toBeNull();
      expect(screen.queryByText(/needs attention before you finish/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Review access and voice pack' })).not.toBeInTheDocument();
      const footer = document.querySelector('.guided-footer')!;
      expect([...footer.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Back', 'Open Voxloom']);
      expect(footer.querySelector('span')).not.toBeNull();
    });
    it('not ready: the attention line, then the Review button, before the shortcut card', async () => {
      const io = setupBoundary();
      vi.mocked(io.query).mockResolvedValue({ microphone: 'authorized', accessibility: 'not-granted' });
      renderWithApp(<Onboarding boundary={io} onClose={vi.fn()} progressStorage={finished()} />);
      const line = await screen.findByText('Access or the voice pack needs attention before you finish.');
      expect(line).toHaveClass('form-error');
      const review = screen.getByRole('button', { name: 'Review access and voice pack' });
      expect(line.nextElementSibling).toBe(review);
      expect(review.nextElementSibling).toHaveClass('guided-shortcut');
      expect(screen.getByRole('button', { name: 'Open Voxloom' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Set up later' })).not.toBeInTheDocument();
    });
    it('not ready because the pack is missing: the specific reason replaces the attention line, with exactly one alert', async () => {
      const io = setupBoundary();
      io.readiness = vi.fn(async (modelId) => ({ modelId, ready: false, status: 'missing' as const, reason: 'Missing' }));
      renderWithApp(<Onboarding boundary={io} onClose={vi.fn()} progressStorage={finished()} />);
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Missing');
      expect(alert).toHaveClass('form-error');
      expect(screen.getAllByRole('alert')).toHaveLength(1);
      expect(screen.queryByText('Access or the voice pack needs attention before you finish.')).not.toBeInTheDocument();
      const review = screen.getByRole('button', { name: 'Review access and voice pack' });
      expect(alert.nextElementSibling).toBe(review);
      expect(review.nextElementSibling).toHaveClass('guided-shortcut');
    });
    it('not ready with no specific error keeps the generic attention line and no alert', async () => {
      const io = setupBoundary();
      vi.mocked(io.query).mockResolvedValue({ microphone: 'authorized', accessibility: 'not-granted' });
      renderWithApp(<Onboarding boundary={io} onClose={vi.fn()} progressStorage={finished()} />);
      expect(await screen.findByText('Access or the voice pack needs attention before you finish.')).toBeVisible();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    it('ready with an error (save failure) keeps the shared bottom alert, once', async () => {
      const io = setupBoundary();
      renderWithApp(<Onboarding boundary={io} onClose={vi.fn()} progressStorage={{ ...finished(), write: () => { throw new Error('quota'); } }} />);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Open Voxloom' })).toBeEnabled());
      const alerts = screen.getAllByRole('alert');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toHaveTextContent(/Setup progress could not be saved/);
      expect(alerts[0].closest('.guided-content')!.lastElementChild).toBe(alerts[0]);
      expect(screen.queryByRole('button', { name: 'Review access and voice pack' })).not.toBeInTheDocument();
    });
    it.each([1, 2, 3])('step %i keeps the specific error at the shared bottom spot', async (step) => {
      const io = setupBoundary();
      io.readiness = vi.fn(async (modelId) => ({ modelId, ready: false, status: 'missing' as const, reason: 'Missing' }));
      renderWithApp(<Onboarding boundary={io} onClose={vi.fn()} progressStorage={{ read: () => JSON.stringify({ version: 1, step, holdDone: true, tapDone: false, mode: 'tap', modelId: 'whisper-base.en', shortcut: 'Ctrl + Shift + Space' }), write: vi.fn() }} />);
      const alert = await screen.findByRole('alert');
      expect(screen.getAllByRole('alert')).toHaveLength(1);
      expect(alert).toHaveTextContent('Missing');
      expect(alert.closest('.guided-content')!.lastElementChild).toBe(alert);
      expect(screen.queryByText('Access or the voice pack needs attention before you finish.')).not.toBeInTheDocument();
    });
    it('Escape on step 4 still closes the window', async () => {
      const user = userEvent.setup();
      const close = vi.fn();
      renderWithApp(<Onboarding boundary={setupBoundary()} onClose={close} progressStorage={finished()} />);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Open Voxloom' })).toBeEnabled());
      await user.keyboard('{Escape}');
      expect(close).toHaveBeenCalledOnce();
    });
    it.each([0, 1, 2, 3])('step %i keeps Set up later', (step) => {
      renderWithApp(<Onboarding boundary={setupBoundary()} onClose={vi.fn()} progressStorage={{ read: () => JSON.stringify({ version: 1, step, holdDone: true, tapDone: false, mode: 'tap', modelId: 'whisper-base.en', shortcut: 'Ctrl + Shift + Space' }), write: vi.fn() }} />);
      expect(screen.getByRole('button', { name: 'Set up later' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Skip setup' })).not.toBeInTheDocument();
    });
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
    expect(screen.getByRole('button', { name: 'Change shortcut' })).toHaveAccessibleDescription('Hold the keys while you talk. Let go when you’re done.');
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
