/// Practice-to-product gesture transition integration tests.
///
/// Verifies that partial tap state is discarded when moving from practice
/// to product context and that latched practice gestures do not carry over.
/// Capture hook and Tauri IPC are mocked globally in setup.ts.
import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { useApp } from '../../src/app/AppContext';
import { renderWithApp } from './testUtils';

vi.mock('../../src/features/onboarding/setupBoundary', () => ({ createSetupBoundary: () => ({
  native: true, query: async () => ({ microphone: 'authorized', accessibility: 'authorized', inputMonitoring: 'authorized' }),
  readiness: async (modelId: string) => ({ modelId, ready: true, reason: null }),
  request: vi.fn(), openSettings: vi.fn(), download: vi.fn(), cancelDownload: vi.fn(), activeShortcut: () => 'Ctrl + Shift + Space',
}) }));
beforeEach(() => localStorage.setItem('voxloom.guided-setup.v1', JSON.stringify({ version: 1, step: 3 })));
afterEach(() => localStorage.clear());

function DictationStatus() {
  const { state } = useApp();
  return <output data-testid="dictation-status">{state.dictation.kind}</output>;
}

const shortcut = {
  code: 'Space',
  ctrlKey: true,
  key: ' ',
  shiftKey: true,
};

/// Navigate to onboarding step 3 (practice screen).
/// Permission is authorized by the global mock so step 1 advances cleanly.
async function reachPractice(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('textbox', { name: 'Practice dictation field' }));
}

function tap() {
  fireEvent.keyDown(document, shortcut);
  fireEvent.keyUp(document, shortcut);
}

describe('practice interaction transitions', () => {
  it('resets a partial tap between practice and product', async () => {
    let now = 0;
    const user = userEvent.setup();
    renderWithApp(<><App /><DictationStatus /></>, () => now);
    await reachPractice(user);
    tap();
    await user.click(screen.getByRole('button', { name: 'Close Set up Voxloom' }));

    vi.useFakeTimers();
    now = 100;
    tap();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(260));
    now = 400;
    fireEvent.keyDown(document, shortcut);
    act(() => vi.advanceTimersByTime(319));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId('dictation-status')).toHaveTextContent('listening');
    fireEvent.keyUp(document, shortcut);
    expect(screen.getByTestId('dictation-status')).toHaveTextContent('cancelled');
    act(() => vi.advanceTimersByTime(500));
    vi.useRealTimers();
  });

  it(
    'does not carry a latched practice gesture into product',
    async () => {
      let now = 0;
      const user = userEvent.setup();
      renderWithApp(<><App /><DictationStatus /></>, () => now);
      await reachPractice(user);
      tap();
      now = 100;
      tap();
      expect(screen.getByRole('textbox', { name: 'Practice dictation field' })).toHaveValue('');
      await user.click(screen.getByRole('button', { name: 'Close Set up Voxloom' }));

      vi.useFakeTimers();
      now = 150;
      tap();
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      now = 200;
      tap();
      expect(screen.getByTestId('dictation-status')).toHaveTextContent('listening');
      now = 250;
      tap();
      // Finish clears the run immediately (no stuck waveform).
      expect(screen.getByTestId('dictation-status')).toHaveTextContent('cancelled');
      act(() => vi.advanceTimersByTime(500));
      vi.useRealTimers();
    },
  );
});
