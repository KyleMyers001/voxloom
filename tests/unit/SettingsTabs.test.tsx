import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '../../src/features/settings/Settings';
import { isTauriEnv } from '../../src/services/capture/captureService';
import { renderWithApp } from './testUtils';

afterEach(() => vi.mocked(isTauriEnv).mockReturnValue(false));

describe('Settings window tabs (UI PR 6a)', () => {
  it('has Capture · Models · Appearance · Privacy tabs with arrow-key navigation', async () => {
    const user = userEvent.setup();
    renderWithApp(<Settings onSetup={vi.fn()} />);
    const tabs = within(screen.getByRole('tablist', { name: 'Settings sections' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Capture', 'Models', 'Appearance', 'Privacy']);
    expect(screen.getByRole('tabpanel', { name: 'Capture' })).toHaveTextContent('Capture & Output');
    tabs[0].focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Models' }));
    await user.keyboard('{End}');
    expect(screen.getByRole('tabpanel', { name: 'Privacy' })).toHaveTextContent('Privacy & Recovery');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Capture' })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps every CHECKLIST Settings feature reachable in the browser preview', async () => {
    const user = userEvent.setup();
    renderWithApp(<Settings onSetup={vi.fn()} />);
    // S1–S11
    expect(screen.getByRole('button', { name: 'Set up shortcuts' })).toBeInTheDocument();
    expect(screen.getByLabelText('Shortcut')).toBeInTheDocument();
    expect(screen.getByLabelText('Microphone')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Refresh microphones/ })).toBeInTheDocument();
    expect(screen.getByText('Microphone test')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'English (UK)' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Current style' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Language-processing model · simulated/)).toBeEnabled();
    expect(screen.getByRole('switch', { name: 'Start at login · simulated' })).toBeEnabled();
    expect(screen.getByRole('switch', { name: 'Use clipboard if direct insertion fails' })).toBeEnabled();
    expect(screen.getByText('Recording indicator')).toBeInTheDocument();
    // A1
    await user.click(screen.getByRole('tab', { name: 'Appearance' }));
    expect(screen.getAllByRole('radio')).toHaveLength(3); // Follow system · Light · Dark (Sodium Rain removed, PR 10)
    // R1–R3, E1
    await user.click(screen.getByRole('tab', { name: 'Privacy' }));
    expect(screen.getByRole('radiogroup', { name: 'Transcript retention' })).toBeInTheDocument();
    expect(screen.getByLabelText('Audio retention')).toBeEnabled();
    expect(screen.getByText('Stays on this Mac')).toBeInTheDocument();
    expect(document.querySelectorAll('.recovery-item')).toHaveLength(6);
    for (const item of document.querySelectorAll('.recovery-item')) expect(item.querySelector('svg')).not.toBeNull();
    expect(screen.getByText(/Temporary recovery buffers expire/)).toBeInTheDocument();
  });

  it('toggles clipboard fallback through the switch', async () => {
    const user = userEvent.setup();
    renderWithApp(<Settings onSetup={vi.fn()} />);
    const fallback = screen.getByRole('switch', { name: 'Use clipboard if direct insertion fails' });
    const before = fallback.getAttribute('aria-checked');
    await user.click(fallback);
    expect(fallback.getAttribute('aria-checked')).not.toBe(before);
  });

  it('hides browser-only rows in the native app', () => {
    vi.mocked(isTauriEnv).mockReturnValue(true);
    renderWithApp(<Settings onSetup={vi.fn()} />);
    expect(screen.queryByLabelText(/Language-processing model/)).toBeNull();
    expect(screen.queryByRole('option', { name: 'English (UK)' })).toBeNull();
    expect(screen.getByText('English-first')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Start at login · unavailable/ })).toBeDisabled();
  });
});
