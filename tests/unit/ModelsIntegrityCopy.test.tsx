/// BUS-35: damaged existing-model copy; no double period in other failures.
/// (The damaged-download copy is covered by ModelsDownloadDamaged.test.tsx.)
import { act, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ModelsTab } from '../../src/features/settings/ModelsTab';
import { createMockSttModelStore } from '../../src/services/stt/mockStt';
import { SttError } from '../../src/services/stt/types';
import { MODEL_UNREADABLE, useSttModels } from '../../src/services/stt/useSttModels';
import { renderWithApp } from './testUtils';

const factory = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('../../src/services/stt/factory', async (importActual) => {
  const actual = await importActual<typeof import('../../src/services/stt/factory')>();
  return { ...actual, createSttModelStore: () => factory.store ?? actual.createSttModelStore() };
});

describe('BUS-35 integrity copy', () => {
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

  it.each([
    ['unreadable', MODEL_UNREADABLE],
    ['damaged', 'Model file is damaged. Download it again.'],
  ] as const)('shows the %s copy with Retry download on the row', async (reason, copy) => {
    const store = createMockSttModelStore();
    const models = await store.list();
    vi.spyOn(store, 'list').mockResolvedValue(
      models.map((m) => (m.id === 'whisper-base.en' ? { ...m, status: 'failed' as const, failureReason: reason } : m)),
    );
    factory.store = store;
    renderWithApp(<ModelsTab />);
    const row = (await screen.findByText('whisper-base.en')).closest('li')!;
    expect(within(row).getByRole('alert').textContent).toBe(copy);
    expect(within(row).getByRole('button', { name: 'Retry download' })).toHaveClass('primary');
    factory.store = null;
  });

  it('re-downloads a damaged existing file in one click', async () => {
    const store = createMockSttModelStore({ downloadSteps: 1 });
    const realList = store.list.bind(store);
    // Native reports the damaged file as failed until a new download replaces it.
    vi.spyOn(store, 'list').mockImplementation(async () =>
      (await realList()).map((m) =>
        m.id === 'whisper-base.en' && m.status === 'missing' ? { ...m, status: 'failed' as const } : m,
      ),
    );
    const download = vi.spyOn(store, 'download');
    factory.store = store;
    const user = userEvent.setup();
    renderWithApp(<ModelsTab />);
    const row = (await screen.findByText('whisper-base.en')).closest('li')!;
    await user.click(await within(row).findByRole('button', { name: 'Retry download' }));
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0][0]).toBe('whisper-base.en');
    expect(await within(row).findByText('On disk')).toBeInTheDocument();
    expect(within(row).queryByRole('alert')).toBeNull();
    factory.store = null;
  });
});
