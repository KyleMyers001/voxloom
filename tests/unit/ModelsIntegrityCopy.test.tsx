/// BUS-35: corrupted-model copy and no double period in download failures.
import { act, renderHook, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModelsTab } from '../../src/features/settings/ModelsTab';
import { createMockSttModelStore } from '../../src/services/stt/mockStt';
import { SttError } from '../../src/services/stt/types';
import { useSttModels } from '../../src/services/stt/useSttModels';
import { renderWithApp } from './testUtils';

const factory = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('../../src/services/stt/factory', async (importActual) => {
  const actual = await importActual<typeof import('../../src/services/stt/factory')>();
  return { ...actual, createSttModelStore: () => factory.store ?? actual.createSttModelStore() };
});

describe('BUS-35 integrity copy', () => {
  it('does not double the period after a backend message that ends in one', async () => {
    const store = createMockSttModelStore();
    vi.spyOn(store, 'download').mockRejectedValueOnce(new SttError('download-failed', 'Download was corrupted. Try again.'));
    const { result } = renderHook(() => useSttModels({ onSelect: vi.fn(), selectedModelId: 'whisper-tiny.en', store }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.downloadModel('whisper-base.en').catch(() => {}); });
    expect(result.current.failures['whisper-base.en']).toBe('Download failed: Download was corrupted. Try again. Nothing was saved.');
  });

  it('shows a corrupted existing file (status failed) with Retry', async () => {
    const store = createMockSttModelStore();
    const models = await store.list();
    vi.spyOn(store, 'list').mockResolvedValue(
      models.map((m) => (m.id === 'whisper-base.en' ? { ...m, status: 'failed' as const } : m)),
    );
    factory.store = store;
    renderWithApp(<ModelsTab />);
    const row = (await screen.findByText('whisper-base.en')).closest('li')!;
    expect(within(row).getByRole('alert')).toHaveTextContent('Model file is corrupted. Download it again.');
    expect(within(row).getByRole('button', { name: 'Retry download' })).toBeInTheDocument();
    factory.store = null;
  });
});
