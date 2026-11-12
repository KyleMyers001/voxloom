/// App integration tests.
///
/// The capture hook and Tauri IPC are mocked globally in setup.ts.
/// These tests exercise app navigation, dictation flow, onboarding steps,
/// and shortcut state across screens. Real permission and device flows
/// are covered by manual on-device tests.
import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { renderWithApp } from './testUtils';

const progressKey = 'voxloom.guided-setup.v1';
const shortcutKey = {
  code: 'Space',
  ctrlKey: true,
  key: ' ',
  shiftKey: true,
};

describe('App integration', () => {
  it('keeps Set up later visibly incomplete with a resume action rather than claiming Ready', async () => {
    const user = userEvent.setup();
    renderWithApp(<App />);
    await user.click(screen.getByRole('button', { name: 'Set up later' }));
    expect(screen.getByText(/Setup is incomplete/)).toBeInTheDocument();
    expect(document.querySelector('.brand__status')).toHaveTextContent('Setup incomplete');
    await user.click(screen.getByRole('button', { name: 'Resume setup' }));
    expect(screen.getByRole('main', { name: 'Set up Voxloom' })).toBeInTheDocument();
  });
  it('Skip setup finishes setup without practice so it no longer blocks the shortcut', async () => {
    localStorage.setItem(progressKey, JSON.stringify({ version: 1, step: 2 }));
    try {
      const user = userEvent.setup();
      renderWithApp(<App />);
      await user.click(screen.getByRole('button', { name: 'Skip setup' }));
      expect(screen.queryByRole('main', { name: 'Set up Voxloom' })).not.toBeInTheDocument();
      expect(screen.queryByText(/Setup is incomplete/)).not.toBeInTheDocument();
      expect(document.querySelector('.brand__status')).toHaveTextContent('Ready');
      expect(localStorage.getItem(progressKey)).toBeNull();
    } finally { localStorage.clear(); }
  });
  it('Resume setup restores unfinished progress while reopening setup from Settings starts practice over', async () => {
    localStorage.setItem(progressKey, JSON.stringify({ version: 1, step: 3, holdDone: true, tapDone: false, mode: 'tap', modelId: 'whisper-base.en', shortcut: 'Ctrl + Shift + Space' }));
    try {
      const user = userEvent.setup();
      renderWithApp(<App />);
      expect(screen.getByRole('heading', { name: 'Now, go hands-free.' })).toBeInTheDocument();
      await user.keyboard('{Escape}');
      await user.click(screen.getByRole('button', { name: 'Resume setup' }));
      expect(screen.getByRole('heading', { name: 'Now, go hands-free.' })).toBeInTheDocument();
      await user.keyboard('{Escape}');
      await user.click(screen.getByRole('button', { name: 'Settings' }));
      await user.click(screen.getByRole('button', { name: 'Set up shortcuts' }));
      expect(screen.getByText(/Less typing/)).toBeInTheDocument();
      expect(JSON.parse(localStorage.getItem(progressKey) ?? 'null')).toMatchObject({ step: 0, holdDone: false, tapDone: false, mode: 'hold' });
    } finally { localStorage.clear(); }
  });
  it('does not turn browser gestures into completed dictation practice', async () => {
    renderWithApp(<App />);
    expect(screen.getByRole('button', { name: /Start setup/ })).toBeDisabled();
    fireEvent.keyDown(document, shortcutKey);
    fireEvent.keyUp(document, shortcutKey);
    expect(screen.queryByRole('button', { name: /Simulate/ })).not.toBeInTheDocument();
    expect(screen.getByRole('main', { name: 'Set up Voxloom' })).toBeInTheDocument();
  });

  it('gates first run, gesture overlay without synthetic Inserted, shares mutations',
    async () => {
      const user = userEvent.setup();
      renderWithApp(<App />);
      expect(screen.getByRole('main', {
        name: 'Set up Voxloom',
      })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Set up later' }));
      vi.useFakeTimers();
      fireEvent.keyDown(document, shortcutKey);
      act(() => vi.advanceTimersByTime(320));
      // The waveform now lives only in the separate desktop overlay.
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      fireEvent.keyUp(document, shortcutKey);
      act(() => vi.advanceTimersByTime(500));
      vi.useRealTimers();
      // Product hold no longer invents Inserted via mock complete (BUS-14).
      // Real delivery is dogfood STT → deliverTranscript (Mac / Home).
      expect(screen.queryByText(
        'Keep the TypeScript boundary small and explicit.',
      )).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Settings' }));
      await user.click(within(
        screen.getByRole('radiogroup', { name: 'Current style' }),
      ).getByRole('radio', { name: 'Casual' }));
      // ⌥-digits are ignored while a form control has focus, so blur first.
      (document.activeElement as HTMLElement | null)?.blur();
      await user.keyboard('{Alt>}1{/Alt}');
      expect(screen.getByRole('radio', { name: /^Casual$/ }))
        .toHaveAttribute('aria-checked', 'true');
      await user.click(
        screen.getByRole('button', { name: 'Dictionary' }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Add term' }),
      );
      await user.type(screen.getByLabelText('Word'), 'Vite');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(screen.getByText('Vite')).toBeInTheDocument();
    });

  it('opens help with question mark and closes with Escape', async () => {
    const user = userEvent.setup();
    renderWithApp(<App />);
    await user.click(screen.getByRole('button', { name: 'Set up later' }));
    await user.keyboard('?');
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' }))
      .toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it(
    'suppresses app shortcuts while a dictionary dialog is open',
    async () => {
      let now = 0;
      const user = userEvent.setup();
      renderWithApp(<App />, () => now);
      await user.click(screen.getByRole('button', { name: 'Set up later' }));
      await user.click(
        screen.getByRole('button', { name: 'Dictionary' }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Add term' }),
      );
      fireEvent.keyDown(document, shortcutKey);
      fireEvent.keyUp(document, shortcutKey);
      await user.keyboard('?');
      await user.keyboard('{Alt>}1{/Alt}');
      expect(
        screen.getByRole('dialog', { name: 'Add dictionary word' }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('dialog', { name: 'Keyboard shortcuts' }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Dictionary' }),
      ).toHaveAttribute('aria-current', 'page');
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      await user.keyboard('{Escape}');
      now = 10;
      fireEvent.keyDown(document, shortcutKey);
      fireEvent.keyUp(document, shortcutKey);
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      vi.useFakeTimers();
      now = 300;
      fireEvent.keyDown(document, shortcutKey);
      act(() => vi.advanceTimersByTime(319));
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      fireEvent.keyUp(document, shortcutKey);
      act(() => vi.advanceTimersByTime(500));
      vi.useRealTimers();
    },
  );

  it(
    'reset restores first-run fixtures and shortcut setup reopens',
    async () => {
      const user = userEvent.setup();
      renderWithApp(<App />);
      await user.click(
        screen.getByRole('button', { name: 'Set up later' }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Empty lists' }),
      );
      expect(
        screen.getByText('No dictations yet.'),
      ).toBeInTheDocument();
      await user.click(
        screen.getByRole('button', { name: 'Reset session' }),
      );
      expect(screen.getByText(/Less typing/)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Set up later' }));
      expect(
        screen.getAllByRole('button', { name: 'Copy dictation' }),
      ).toHaveLength(5);

      await user.click(
        screen.getByRole('button', { name: 'Settings' }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Set up shortcuts' }),
      );
      // Real setup cannot be completed by development gesture simulations.
      expect(screen.getByRole('button', { name: /Start setup/ })).toBeDisabled();
      await user.keyboard('{Escape}');
      const setup = screen.getByRole('button', { name: 'Set up shortcuts' });
      await user.click(setup);
      expect(screen.getByText(/Less typing/)).toBeInTheDocument();
      await user.keyboard('{Escape}');
      expect(setup).toHaveFocus();
    },
  );

  it('development First-run setup starts the guided tutorial over instead of resuming it', async () => {
    localStorage.setItem(progressKey, JSON.stringify({ version: 1, step: 2 }));
    try {
      const user = userEvent.setup();
      renderWithApp(<App />);
      expect(screen.getByRole('heading', { name: /Your shortcut/ })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Set up later' }));
      await user.click(screen.getByRole('button', { name: 'First-run setup' }));
      expect(screen.getByText(/Less typing/)).toBeInTheDocument();
      // Real setup still cannot be completed by development controls.
      expect(screen.getByRole('button', { name: /Start setup/ })).toBeDisabled();
    } finally { localStorage.clear(); }
  });
});
