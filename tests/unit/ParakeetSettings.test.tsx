import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureTab } from '../../src/features/settings/CaptureTab';
import { ModelsTab } from '../../src/features/settings/ModelsTab';
import { isTauriEnv } from '../../src/services/capture/captureService';
import { renderWithApp } from './testUtils';

afterEach(() => vi.mocked(isTauriEnv).mockReturnValue(false));

describe('Parakeet existing settings integration', () => {
  it('offers both explicit local models and shows automatic multilingual recognition only for v3', async () => {
    vi.mocked(isTauriEnv).mockReturnValue(true);
    const user = userEvent.setup();
    renderWithApp(<><ModelsTab /><CaptureTab onSetup={vi.fn()} /></>);
    const v3 = await screen.findByRole('radio', { name: /Parakeet v3/ });
    const v2 = screen.getByRole('radio', { name: /Parakeet v2/ });
    expect(screen.getByText(/Local Whisper and Parakeet models/)).toBeInTheDocument();
    expect(screen.getByText('English-first')).toBeInTheDocument();
    await user.click(v3);
    expect(v3).toBeChecked();
    expect(screen.getByLabelText('Language')).toBeDisabled();
    expect(screen.getByLabelText('Language')).toHaveValue('Automatic (Multilingual)');
    expect(screen.getByText('Multilingual')).toBeInTheDocument();
    expect(screen.queryByText('English-first')).toBeNull();
    expect(within(v3.closest('li')!).getByRole('button', { name: 'Download' })).toBeInTheDocument();
    await user.click(v2);
    expect(screen.getByLabelText('Language')).toHaveValue('English (US)');
    expect(screen.getByText('English-first')).toBeInTheDocument();
  });
});
