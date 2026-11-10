import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureTab } from '../../src/features/settings/CaptureTab';
import { ModelCard } from '../../src/features/settings/ModelCard';
import { ModelsTab } from '../../src/features/settings/ModelsTab';
import { isTauriEnv } from '../../src/services/capture/captureService';
import { renderWithApp } from './testUtils';

const model = {
  id: 'whisper-large-v3-turbo',
  label: 'Whisper Large v3 Turbo (English)',
  sizeBytes: 1_624_555_275,
  status: 'missing' as const,
};

afterEach(() => vi.mocked(isTauriEnv).mockReturnValue(false));

describe('Whisper Turbo settings', () => {
  it('explains its download size and higher resource use before downloading', () => {
    render(<ModelCard failure={undefined} model={model} onCancel={vi.fn()} onDownload={vi.fn()} onSelect={vi.fn()} progress={null} selected={false} />);
    expect(screen.getByText('1.62 GB')).toBeInTheDocument();
    expect(screen.getByText('Larger download and higher memory use than Tiny or Base.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();
  });

  it('labels both received and total units during a large download', () => {
    render(<ModelCard failure={undefined} model={model} onCancel={vi.fn()} onDownload={vi.fn()} onSelect={vi.fn()} progress={{ modelId: model.id, bytesReceived: 812_277_637, bytesTotal: model.sizeBytes, ratio: 0.5 }} selected={false} />);
    expect(screen.getByText('50% · 812 MB of 1.62 GB')).toBeInTheDocument();
  });

  it('selects Turbo without downloading and keeps native recognition English-first', async () => {
    vi.mocked(isTauriEnv).mockReturnValue(true);
    const user = userEvent.setup();
    renderWithApp(<><ModelsTab /><CaptureTab onSetup={vi.fn()} /></>);
    const turbo = await screen.findByRole('radio', { name: /Whisper Large v3 Turbo \(English\)/ });
    expect(screen.getByRole('radio', { name: /Whisper Base/ })).toBeChecked();
    await user.click(turbo);
    expect(turbo).toBeChecked();
    const card = within(turbo.closest('li')!);
    expect(card.getByRole('button', { name: 'Download' })).toBeEnabled();
    expect(card.queryByRole('button', { name: 'Cancel download' })).toBeNull();
    expect(card.getByText(/download required before dictating/)).toBeInTheDocument();
    expect(screen.getByLabelText('Language')).toBeDisabled();
    expect(screen.getByLabelText('Language')).toHaveValue('English (US)');
    expect(screen.getByText('English-first')).toBeInTheDocument();
    expect(screen.queryByText('Automatic (Multilingual)')).toBeNull();
  });
});
