import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModelCard } from '../../src/features/settings/ModelCard';
import { createMockSttModelStore } from '../../src/services/stt/mockStt';
import { ensureModelAvailable } from '../../src/services/stt/dogfoodModel';

describe('Parakeet platform availability', () => {
  it('keeps a persisted unsupported selection visible without offering selection or download', async () => {
    const model = { id: 'parakeet-tdt-0.6b-v3', label: 'Parakeet v3 (Multilingual)', sizeBytes: 0, status: 'missing' as const, supported: false, unavailableReason: 'Requires Apple Silicon and macOS 14 or later.' };
    render(<ModelCard model={model} selected progress={null} failure={undefined} onSelect={vi.fn()} onDownload={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('radio')).toBeChecked();
    expect(screen.getByRole('radio')).toBeDisabled();
    expect(screen.getByText(model.unavailableReason)).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
    expect(screen.queryByText(/download required/)).toBeNull();
    expect(screen.queryByText('0 MB')).toBeNull();
    const store = createMockSttModelStore();
    vi.spyOn(store, 'status').mockResolvedValue(model);
    await expect(ensureModelAvailable(store, model.id)).rejects.toMatchObject({ code: 'unsupported-platform', message: model.unavailableReason });
  });
});
