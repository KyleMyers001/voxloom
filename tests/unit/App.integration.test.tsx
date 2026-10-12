/// App integration tests.
///
/// The capture hook and Tauri IPC are mocked globally in setup.ts.
/// These tests exercise app navigation, dictation flow, onboarding steps,
/// and shortcut state across screens. Real permission and device flows
/// are covered by manual tests in docs/review/BUS-9-implementation.md.
import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { renderWithApp } from './testUtils';

/// Advance through onboarding step 1 (mic authorized by mock) and step 2.
async function reachStep3(user: ReturnType<typeof userEvent.setup>) {
  // Step 1: permission is authorized by global mock; Next passes.
  await user.click(screen.getByRole('button', { name: 'Next' }));
  // Step 2: shortcut — advance.
  await user.click(screen.getByRole('button', { name: 'Next' }));
}

const shortcutKey = {
  code: 'Space',
  ctrlKey: true,
  key: ' ',
  shiftKey: true,
};

describe('App integration', () => {
  it('drives onboarding practices from configured gestures', async () => {
    let now = 0;
    const user = userEvent.setup();
    renderWithApp(<App />, () => now);
    await reachStep3(user);
    vi.useFakeTimers();
    fireEvent.keyDown(document, shortcutKey);
    now = 320;
    act(() => vi.advanceTimersByTime(320));
    fireEvent.keyUp(document, shortcutKey);
    expect(screen.getByText(/Press-and-hold · recognized/))
      .toBeInTheDocument();
    now = 400;
    fireEvent.keyDown(document, shortcutKey);
    fireEvent.keyUp(document, shortcutKey);
    now = 500;
    fireEvent.keyDown(document, shortcutKey);
    fireEvent.keyUp(document, shortcutKey);
    now = 600;
    fireEvent.keyDown(document, shortcutKey);
    fireEvent.keyUp(document, shortcutKey);
    expect(screen.getByText(/Rapid double-tap · recognized/))
      .toBeInTheDocument();
    vi.useRealTimers();
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('gates first run, gesture overlay without synthetic Inserted, shares mutations',
    async () => {
      const user = userEvent.setup();
      renderWithApp(<App />);
      expect(screen.getByRole('dialog', {
        name: 'Set up Voxloom',
      })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Skip' }));
      vi.useFakeTimers();
      fireEvent.keyDown(document, shortcutKey);
      act(() => vi.advanceTimersByTime(320));
      // The waveform now lives only in the separate desktop overlay.
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      fireEvent.keyUp(document, shortcutKey);
      act(() => vi.advanceTimersByTime(500));
      vi.useRealTimers();
      // Product hold no longer invents Inserted via mock complete (BUS-14).
      // Real delivery is dogfood STT → deliverTranscript (Clara Mac / Home).
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
    await user.click(screen.getByRole('button', { name: 'Skip' }));
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
      await user.click(screen.getByRole('button', { name: 'Skip' }));
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
        screen.getByRole('button', { name: 'Skip' }),
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
      expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Skip' }));
      expect(
        screen.getAllByRole('button', { name: 'Copy dictation' }),
      ).toHaveLength(5);

      await user.click(
        screen.getByRole('button', { name: 'Settings' }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Set up shortcuts' }),
      );
      // Step 1: authorized mock; advance directly.
      await user.click(
        screen.getByRole('button', { name: 'Next' }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Next' }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Simulate hold' }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Simulate double-tap' }),
      );
      await user.click(screen.getByRole('button', { name: 'Finish' }));

      const setup = screen.getByRole('button', {
        name: 'Set up shortcuts',
      });
      await user.click(setup);
      expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Next' }));
      await user.click(screen.getByRole('button', { name: 'Next' }));
      expect(
        screen.getByText(/Press-and-hold · not tested/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Rapid double-tap · not tested/),
      ).toBeInTheDocument();
      await user.keyboard('{Escape}');
      expect(setup).toHaveFocus();
    },
  );

  it(
    'surfaces shortcut collision scenario from ScenarioPanel',
    async () => {
      const user = userEvent.setup();
      renderWithApp(<App />);
      await user.click(
        screen.getByRole('button', { name: 'Skip' }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Shortcut collision' }),
      );
      // Step 2 is shown; advance with the pre-filled collision shortcut.
      await user.click(
        screen.getByRole('button', { name: 'Next' }),
      );
      expect(
        screen.getByRole('alert'),
      ).toHaveTextContent('already in use');
    },
  );
});
