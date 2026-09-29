import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ScenarioPanel } from '../../src/dev/ScenarioPanel';
import { renderWithApp } from './testUtils';

describe('ScenarioPanel', () => {
  it('drives deterministic mock states and reset', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    renderWithApp(<ScenarioPanel onOnboarding={vi.fn()} onReset={reset} />);
    await user.click(screen.getByRole('button', {
      name: 'Listening · silent',
    }));
    expect(screen.getByRole('button', { name: 'Processing' }))
      .toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Processing' }));
    await user.click(screen.getByRole('button', { name: 'Complete error' }));
    await user.click(screen.getByLabelText('Copy failure'));
    expect(screen.getByLabelText('Copy failure')).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Reset session' }));
    expect(reset).toHaveBeenCalledOnce();
  });
});
