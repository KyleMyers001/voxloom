/// BUS-35: damaged-model and damaged-download copy; no double period in other failures.
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
  it('shows the checksum failure exactly, with no wrapper and no hashes', async () => {
    const store = createMockSttModelStore();
    vi.spyOn(store, 'download').mockRejectedValueOnce(new SttError('download-corrupted', 'anything from native'));
    const { result } = renderHook(() => useSttModels({ onSelect: vi.fn(), selectedModelId: 'whisper-tiny.en', store }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.downloadModel('whisper-base.en').catch(() => {}); });
    expect(result.current.failures['whisper-base.en']).toBe('Download was damaged. Nothing was saved.');
  });

  it('does not double the period after another failure message that ends in one', async () => {
    const store = createMockSttModelStore();
    vi.spyOn(store, 'download').mockRejectedValueOnce(new SttError('download-failed', 'Disk is full.'));
    const { result } = renderHook(() => useSttModels({ onSelect: vi.fn(), selectedModelId: 'whisper-tiny.en', store }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.downloadModel('whisper-base.en').catch(() => {}); });
    expect(result.current.failures['whisper-base.en']).toBe('Download failed: Disk is full. Nothing was saved.');
  });

  it('shows a damaged existing file (status failed) with Retry', async () => {
    const store = createMockSttModelStore();
    const models = await store.list();
    vi.spyOn(store, 'list').mockResolvedValue(
      models.map((m) => (m.id === 'whisper-base.en' ? { ...m, status: 'failed' as const } : m)),
    );
    factory.store = store;
    renderWithApp(<ModelsTab />);
    const row = (await screen.findByText('whisper-base.en')).closest('li')!;
    expect(within(row).getByRole('alert')).toHaveTextContent('Model file is damaged. Download it again.');
    expect(within(row).getByRole('button', { name: 'Retry download' })).toBeInTheDocument();
    factory.store = null;
  });
});
