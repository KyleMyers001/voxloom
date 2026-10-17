/// BUS-76 review: the synthetic pending row must not offer Cancel, and a
/// second mount must not overwrite the first mount's pending marker.
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelCard } from '../../../src/features/settings/ModelCard';
import { createMockSttModelStore } from '../../../src/services/stt/mockStt';
import type { SttModelInfo } from '../../../src/services/stt/types';
import { pendingDownload } from '../../../src/services/stt/useDownloadPoll';
import { useSttModels } from '../../../src/services/stt/useSttModels';

const row = (id: string, status: SttModelInfo['status']): SttModelInfo => ({ id, label: id, sizeBytes: 1, status });
const find = (models: readonly SttModelInfo[], id: string) => models.find((m) => m.id === id);
const opts = (store: ReturnType<typeof createMockSttModelStore>) => ({ onSelect: vi.fn(), selectedModelId: 'whisper-tiny.en', store });

function hangingStore() {
  const finish: Record<string, (fail?: boolean) => void> = {};
  const store = Object.assign(createMockSttModelStore(), {
    download: vi.fn((id: string) => new Promise<void>((resolve, reject) => {
      finish[id] = (fail) => (fail ? reject(new Error('Another model download is already in progress')) : resolve());
    })),
    list: vi.fn(async () => [row('whisper-tiny.en', 'missing'), row('whisper-base.en', 'missing')]),
  });
  return { finish, store };
}

describe('pending row is not cancelable (BUS-76)', () => {
  afterEach(() => { pendingDownload.modelId = null; });

  it('tags the inherited pending row and ModelCard hides Cancel for it', async () => {
    const { finish, store } = hangingStore();
    const first = renderHook(() => useSttModels(opts(store)));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    let p: Promise<void> = Promise.resolve();
    act(() => { p = first.result.current.downloadModel('whisper-base.en'); });
    first.unmount();
    const second = renderHook(() => useSttModels(opts(store)));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    const shown = find(second.result.current.models, 'whisper-base.en')!;
    expect(shown).toMatchObject({ pending: true, status: 'downloading' });

    const props = { failure: undefined, onCancel: vi.fn(), onDownload: vi.fn(), onSelect: vi.fn(), progress: null, selected: false };
    const { rerender } = render(<ul><ModelCard {...props} model={shown} /></ul>);
    expect(screen.getByText('Downloading…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel download' })).toBeNull();
    // Once the backend reports downloading, Cancel is back.
    rerender(<ul><ModelCard {...props} model={row('whisper-base.en', 'downloading')} /></ul>);
    expect(screen.getByRole('button', { name: 'Cancel download' })).toBeTruthy();

    await act(async () => { finish['whisper-base.en'](); await p; });
    second.unmount();
  });

  it('a second mount starting another model does not overwrite or clear the first marker', async () => {
    const { finish, store } = hangingStore();
    const first = renderHook(() => useSttModels(opts(store)));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    let p1: Promise<void> = Promise.resolve();
    act(() => { p1 = first.result.current.downloadModel('whisper-base.en'); });
    first.unmount();

    const second = renderHook(() => useSttModels(opts(store)));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    let p2: Promise<void> = Promise.resolve();
    act(() => { p2 = second.result.current.downloadModel('whisper-tiny.en'); });
    expect(pendingDownload.modelId).toBe('whisper-base.en');
    await act(async () => { finish['whisper-tiny.en'](true); await p2.catch(() => {}); });
    expect(pendingDownload.modelId).toBe('whisper-base.en');
    expect(find(second.result.current.models, 'whisper-base.en')?.status).toBe('downloading');

    await act(async () => { finish['whisper-base.en'](); await p1; });
    expect(pendingDownload.modelId).toBeNull();
    second.unmount();
  });
});
