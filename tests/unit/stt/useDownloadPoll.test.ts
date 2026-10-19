/// BUS-56: a download owned by an earlier Models mount must not leave the
/// list stuck on `downloading` after it ends.
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMockSttModelStore } from '../../../src/services/stt/mockStt';
import type { SttModelInfo } from '../../../src/services/stt/types';
import { DOWNLOAD_POLL_MS } from '../../../src/services/stt/useDownloadPoll';
import { useSttModels } from '../../../src/services/stt/useSttModels';

const row = (id: string, status: SttModelInfo['status']): SttModelInfo => ({
  id, label: id, sizeBytes: 1, status,
});

/** Backend still downloading base.en for a previous mount; `end()` finishes it. */
function remountedStore(finalStatus: SttModelInfo['status']) {
  const store = createMockSttModelStore();
  let status: SttModelInfo['status'] = 'downloading';
  const list = vi.fn(async () => [row('whisper-tiny.en', 'missing'), row('whisper-base.en', status)]);
  return { end: () => { status = finalStatus; }, list, store: Object.assign(store, { list }) };
}

const base = (models: readonly SttModelInfo[]) => models.find((m) => m.id === 'whisper-base.en')?.status;

describe('useSttModels after remount (BUS-56)', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ['finishes', 'available'],
    ['fails or is canceled', 'missing'],
  ] as const)('refreshes when the other download %s', async (_, finalStatus) => {
    const { end, list, store } = remountedStore(finalStatus);
    const { result } = renderHook(() => useSttModels({ onSelect: vi.fn(), selectedModelId: 'whisper-tiny.en', store }));
    await waitFor(() => expect(base(result.current.models)).toBe('downloading'));
    end();
    await waitFor(() => expect(base(result.current.models)).toBe(finalStatus), { timeout: DOWNLOAD_POLL_MS * 3 });
    const calls = list.mock.calls.length;
    await act(async () => { await new Promise((r) => setTimeout(r, DOWNLOAD_POLL_MS * 1.5)); });
    expect(list.mock.calls.length).toBe(calls);
  });

  it('does not poll when nothing is downloading', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const store = createMockSttModelStore();
    const list = vi.spyOn(store, 'list');
    const { result } = renderHook(() => useSttModels({ onSelect: vi.fn(), selectedModelId: 'whisper-tiny.en', store }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    // BUS-85.2: mount reload + one refresh after the models-changed listener registers.
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await act(async () => { await vi.advanceTimersByTimeAsync(DOWNLOAD_POLL_MS * 5); });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('stops polling on unmount', async () => {
    const { list, store } = remountedStore('downloading');
    const { result, unmount } = renderHook(() => useSttModels({ onSelect: vi.fn(), selectedModelId: 'whisper-tiny.en', store }));
    await waitFor(() => expect(base(result.current.models)).toBe('downloading'));
    unmount();
    const calls = list.mock.calls.length;
    await new Promise((r) => setTimeout(r, DOWNLOAD_POLL_MS * 1.5));
    expect(list.mock.calls.length).toBe(calls);
  });
});
