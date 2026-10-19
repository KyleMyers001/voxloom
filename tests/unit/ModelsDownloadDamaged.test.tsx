/// BUS-16 PR 1: a size or SHA-256 mismatch (`download-corrupted`) shows the BUS-35
/// designer copy on the Models row, with Retry, and never the native message.
import { act, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ModelsTab } from '../../src/features/settings/ModelsTab';
import { createMockSttModelStore } from '../../src/services/stt/mockStt';
import { SttError } from '../../src/services/stt/types';
import { DOWNLOAD_DAMAGED, useSttModels } from '../../src/services/stt/useSttModels';
import { renderWithApp } from './testUtils';

const factory = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('../../src/services/stt/factory', async (importActual) => {
  const actual = await importActual<typeof import('../../src/services/stt/factory')>();
  return { ...actual, createSttModelStore: () => factory.store ?? actual.createSttModelStore() };
});

const NATIVE = 'size mismatch: expected 8192 bytes, sha256 0123abcd';

/** Mock store whose first download of `failId` fails verification. */
function damagedOnceStore(failId = 'whisper-base.en') {
  const store = createMockSttModelStore({ downloadSteps: 1 });
  const real = store.download.bind(store);
  let failed = false;
  const download = vi.fn(async (id: string, onProgress?: Parameters<typeof real>[1]) => {
    if (id === failId && !failed) {
      failed = true;
      throw new SttError('download-corrupted', NATIVE);
    }
    return real(id, onProgress);
  });
  return Object.assign(store, { download });
}

describe('download-corrupted copy', () => {
  it('is exactly DOWNLOAD_DAMAGED, with no wrapper and no native detail', async () => {
    expect(DOWNLOAD_DAMAGED).toBe('Download was damaged. Nothing was saved.');
    const store = damagedOnceStore();
    const { result } = renderHook(() => useSttModels({ onSelect: vi.fn(), selectedModelId: 'whisper-tiny.en', store }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.downloadModel('whisper-base.en').catch(() => {}); });
    expect(result.current.failures['whisper-base.en']).toBe(DOWNLOAD_DAMAGED);
  });

  it('shows on the Models row with a Retry that restarts the download', async () => {
    const store = damagedOnceStore();
    factory.store = store;
    const user = userEvent.setup();
    renderWithApp(<ModelsTab />);
    const row = (await screen.findByText('whisper-base.en')).closest('li')!;
    await user.click(within(row).getByRole('button', { name: 'Download' }));
    const retry = await within(row).findByRole('button', { name: 'Retry download' });
    expect(within(row).getByRole('alert').textContent).toBe(DOWNLOAD_DAMAGED);
    expect(row.textContent).not.toContain('0123abcd');
    await user.click(retry);
    expect(await within(row).findByText('On disk')).toBeInTheDocument();
    expect(within(row).queryByRole('alert')).toBeNull();
    expect(store.download).toHaveBeenCalledTimes(2);
    factory.store = null;
  });
});
